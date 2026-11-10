import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  actOnZohoInterviewCampaign,
  createZohoInterviewCampaign,
  getGetZohoCampaignWorkspaceQueryKey,
  getGetZohoInterviewCampaignQueryKey,
  getZohoCampaignWorkspace,
  getZohoInterviewCampaign,
} from "@workspace/api-client-react";
import type {
  ZohoCampaignDetail,
  ZohoCampaignSummary,
  ZohoCampaignWorkspace,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { ZohoCampaignReviews } from "./ZohoCampaignReviews";
import { ZohoInterviewNote } from "./ZohoInterviewNote";
import { useZohoRequestScope } from "./useZohoRequestScope";

const STATE_TEXT: Record<string, { label: string; meaning: string; tone: string }> = {
  draft: {
    label: "Draft",
    meaning: "Saved snapshot awaiting employer approval. Nothing sent.",
    tone: "border-muted-foreground/40 text-muted-foreground",
  },
  approved: {
    label: "Approved",
    meaning: "Employer approved. The scheduler processes recipients automatically.",
    tone: "border-primary/50 text-primary",
  },
  queued: {
    label: "Queued",
    meaning: "Approved and waiting for the scheduler. Not sent yet.",
    tone: "border-primary/40 text-primary",
  },
  preparing: {
    label: "Preparing",
    meaning: "Importing the profile and preparing the interview. Not sent yet.",
    tone: "border-primary/40 text-primary",
  },
  sending: {
    label: "Sending",
    meaning: "A send claim is saved. Provider acceptance is not yet confirmed. Do not resend.",
    tone: "border-amber-600/50 text-amber-700 dark:text-amber-400",
  },
  sent: {
    label: "Sent",
    meaning: "Provider accepted the email. This does not confirm delivery.",
    tone: "border-emerald-700/50 text-emerald-700 dark:text-emerald-400",
  },
  blocked: {
    label: "Blocked",
    meaning: "Eligibility, identity or permissions need resolution. No email sent.",
    tone: "border-destructive/50 text-destructive",
  },
  review_required: {
    label: "Review required",
    meaning: "Send outcome is uncertain. Lexy never resends automatically.",
    tone: "border-destructive/60 text-destructive",
  },
  simulated: {
    label: "Simulated",
    meaning: "Test run only. No real email was sent.",
    tone: "border-muted-foreground/40 text-muted-foreground",
  },
  skipped: {
    label: "Skipped",
    meaning: "Not contacted by this campaign.",
    tone: "border-muted-foreground/40 text-muted-foreground",
  },
  cancelled: {
    label: "Cancelled",
    meaning: "Stopped before sending. Already sending/sent emails were not recalled.",
    tone: "border-muted-foreground/40 text-muted-foreground",
  },
};
const stateInfo = (s: string) =>
  STATE_TEXT[s] ?? {
    label: s.replace(/_/g, " "),
    meaning: "Unrecognized state reported by the server.",
    tone: "border-muted-foreground/40",
  };
const ACTIVE = new Set(["approved", "queued", "preparing", "sending"]);

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isWorkspace(v: unknown): v is ZohoCampaignWorkspace {
  const w = v as ZohoCampaignWorkspace | null;
  return (
    !!w &&
    Array.isArray(w.jobs) &&
    Array.isArray(w.campaigns) &&
    w.jobs.every((j) => typeof j?.id === "string" && Array.isArray(j.plans))
  );
}
function isDetail(v: unknown, id?: string): v is ZohoCampaignDetail {
  const d = v as ZohoCampaignDetail | null;
  return (
    !!d &&
    !!d.campaign &&
    typeof d.campaign.id === "string" &&
    typeof d.campaign.snapshotHash === "string" &&
    Array.isArray(d.recipients) &&
    Array.isArray(d.campaign.counts) &&
    (!id || d.campaign.id === id)
  );
}

function StateBadge({ state, id }: { state: string; id: string }) {
  const info = stateInfo(state);
  return (
    <span
      data-testid={`status-${id}`}
      title={info.meaning}
      className={`inline-flex max-w-full items-center whitespace-normal break-words rounded-full border px-2 py-0.5 text-xs font-medium ${info.tone}`}
    >
      {info.label}
    </span>
  );
}

function Counts({ campaign }: { campaign: ZohoCampaignSummary }) {
  if (!campaign.counts.length)
    return <p className="text-muted-foreground">No recipient states reported yet.</p>;
  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {campaign.counts.map((c) => (
        <div
          key={c.state}
          className="min-w-0 rounded border p-2"
          data-testid={`count-${campaign.id}-${c.state}`}
        >
          <dt className="break-words whitespace-normal text-xs text-muted-foreground">
            {stateInfo(c.state).label}
          </dt>
          <dd className="font-mono text-lg tabular-nums">{c.count}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Employer-approved Zoho interview campaigns. Approval sends real emails via the backend scheduler. */
export function ZohoInterviewCampaigns({
  revision,
  providerAvailable,
}: {
  revision: string | null;
  providerAvailable: boolean;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const enabled = user?.role === "tenant_admin";
  const identity = `${user?.id}:${user?.tenantId}:${user?.role}`;
  const canContact = enabled && providerAvailable && !!revision;
  const [jobId, setJobId] = useState("");
  const [planId, setPlanId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "approve" | "cancel">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIdRef = useRef<{ key: string; id: string } | null>(null);
  const isCurrentView = useZohoRequestScope(`${identity}:${selectedId}:${revision}:${canContact}`);

  useEffect(() => {
    setJobId("");
    setPlanId("");
    setSelectedId(null);
    setConsent(false);
    setError("");
    setNotice("");
    setBusy("");
    requestIdRef.current = null;
  }, [identity]);
  useEffect(() => {
    setJobId("");
    setPlanId("");
    setConsent(false);
    setError("");
    setNotice("");
    setBusy("");
    requestIdRef.current = null;
  }, [revision, canContact]);
  useEffect(() => {
    setConsent(false);
    setBusy("");
  }, [selectedId]);

  const wsKey = [...getGetZohoCampaignWorkspaceQueryKey(), identity];
  const workspace = useQuery({
    queryKey: wsKey,
    queryFn: async ({ signal }) => {
      const body = await getZohoCampaignWorkspace({ signal, cache: "no-store" });
      if (!isWorkspace(body))
        throw new Error(
          "Campaign workspace returned an unexpected response. Reload before acting.",
        );
      return body;
    },
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: 8000,
  });
  const detailKey = [...getGetZohoInterviewCampaignQueryKey(selectedId ?? ""), identity];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      const body = await getZohoInterviewCampaign(selectedId!, { signal, cache: "no-store" });
      if (!isDetail(body, selectedId!))
        throw new Error("Campaign detail returned an unexpected response. Reload before acting.");
      return body;
    },
    enabled: enabled && !!selectedId,
    retry: false,
    staleTime: 0,
    refetchInterval: 6000,
  });

  const jobs = workspace.data?.jobs ?? [];
  const campaigns = workspace.data?.campaigns ?? [];
  const job = jobs.find((j) => j.id === jobId);
  const plan = job?.plans.find((p) => p.id === planId);
  const jobTitle = (id: string) => jobs.find((j) => j.id === id)?.title;
  const planTitle = (jid: string, pid: string) =>
    jobs.find((j) => j.id === jid)?.plans.find((p) => p.id === pid)?.title;

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wsKey }),
      selectedId ? qc.invalidateQueries({ queryKey: detailKey }) : Promise.resolve(),
    ]);
  }

  async function createDraft() {
    if (!canContact || !revision || !job || !plan || busy) return;
    const stillCurrent = isCurrentView;
    const key = `${identity}:${job.id}:${plan.id}`;
    if (requestIdRef.current?.key !== key) requestIdRef.current = { key, id: crypto.randomUUID() };
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const body = await createZohoInterviewCampaign({
        revision,
        jobId: job.id,
        planId: plan.id,
        requestId: requestIdRef.current.id,
        confirm: true,
      });
      if (!stillCurrent()) return;
      if (!isDetail(body))
        throw new Error("Draft response was not recognized. Refresh the list before retrying.");
      requestIdRef.current = null;
      setJobId("");
      setPlanId("");
      qc.setQueryData([...getGetZohoInterviewCampaignQueryKey(body.campaign.id), identity], body);
      setSelectedId(body.campaign.id);
      setNotice(
        `Draft saved with ${body.campaign.recipientCount} recipients. Nothing has been sent.`,
      );
      await qc.invalidateQueries({ queryKey: wsKey });
    } catch (cause) {
      if (stillCurrent())
        setError(
          errorText(cause, "The draft could not be created. Retrying keeps the same request"),
        );
    } finally {
      if (stillCurrent()) setBusy("");
    }
  }

  async function act(action: "approve" | "cancel", d: ZohoCampaignDetail) {
    if (!enabled || busy || selectedId !== d.campaign.id) return;
    const stillCurrent = isCurrentView;
    if (action === "approve" && (!canContact || !consent)) return;
    if (
      action === "cancel" &&
      !window.confirm(
        "Cancel this campaign? Recipients not yet sending will be stopped. Emails already sending or sent cannot be recalled.",
      )
    )
      return;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const body = await actOnZohoInterviewCampaign(d.campaign.id, {
        action,
        snapshotHash: d.campaign.snapshotHash,
        confirm: true,
      });
      if (!stillCurrent()) return;
      if (!isDetail(body, d.campaign.id))
        throw new Error("Server response was not recognized. Refresh before acting again.");
      setConsent(false);
      qc.setQueryData(detailKey, body);
      setNotice(
        action === "approve"
          ? "Approved. The scheduler will process this saved snapshot automatically, even if you close this page."
          : "Cancellation recorded. Anything already sending or sent was not recalled.",
      );
      await refresh();
    } catch (cause) {
      if (!stillCurrent()) return;
      setConsent(false);
      setError(
        errorText(
          cause,
          `The ${action === "approve" ? "approval" : "cancellation"} was not recorded`,
        ),
      );
      await refresh();
    } finally {
      if (stillCurrent()) setBusy("");
    }
  }

  if (!enabled) return null;
  const d = detail.data;
  const running = d ? d.recipients.some((r) => ACTIVE.has(r.state)) : false;

  return (
    <section
      className="min-w-0 space-y-5 sm:rounded sm:border sm:p-4"
      aria-label="Zoho interview campaigns"
      data-testid="section-zoho-campaigns"
    >
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Employer approval required
        </p>
        <h2 className="text-base font-semibold">Interview campaigns from Zoho jobs</h2>
        <p className="text-muted-foreground">
          Draft a campaign for an imported, approved job. Lexy saves a snapshot of verified
          applicants and sends nothing until you approve that exact snapshot. Zoho stages are never
          changed, and hiring decisions stay with your team.
        </p>
      </header>

      {!canContact && (
        <p
          role="status"
          className="rounded border border-amber-600/40 bg-amber-500/5 p-3"
          data-testid="text-provider-unavailable"
        >
          Saved campaigns, interview reviews and reviewed handoff downloads remain available to
          authorized employer administrators. Creating snapshots and approving new invitations
          require a current, employer-confirmed Zoho connection. Existing campaigns are not
          cancelled by opening this view.
        </p>
      )}

      {workspace.isLoading && (
        <div className="space-y-2" role="status" aria-label="Loading campaigns">
          <div className="h-9 animate-pulse rounded bg-muted" />
          <div className="h-16 animate-pulse rounded bg-muted" />
        </div>
      )}
      {workspace.isError && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="text-destructive" data-testid="text-workspace-error">
            {errorText(workspace.error, "Campaigns could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-retry-workspace"
            onClick={() => void workspace.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {workspace.data && (
        <>
          {canContact && (
            <div className="space-y-3 rounded border bg-muted/30 p-3">
              <h3 className="font-medium">1. Create a draft</h3>
              {jobs.length === 0 ? (
                <p className="text-muted-foreground" data-testid="text-no-jobs">
                  No approved imported jobs yet. Import a Zoho job above and create an interview
                  plan for it first.
                </p>
              ) : (
                <>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <label className="block min-w-0 space-y-1">
                      <span className="text-xs text-muted-foreground">Imported job</span>
                      <select
                        className="block w-full min-w-0 rounded border bg-background p-2"
                        value={jobId}
                        disabled={!!busy}
                        data-testid="select-campaign-job"
                        onChange={(e) => {
                          setJobId(e.target.value);
                          setPlanId("");
                          setError("");
                          setNotice("");
                          requestIdRef.current = null;
                        }}
                      >
                        <option value="">Choose a job</option>
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.title} (Zoho {j.externalJobId})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0 space-y-1">
                      <span className="text-xs text-muted-foreground">Interview plan</span>
                      <select
                        className="block w-full min-w-0 rounded border bg-background p-2"
                        value={planId}
                        disabled={!!busy || !job || job.plans.length === 0}
                        data-testid="select-campaign-plan"
                        onChange={(e) => {
                          setPlanId(e.target.value);
                          setError("");
                          setNotice("");
                          requestIdRef.current = null;
                        }}
                      >
                        <option value="">
                          {job && job.plans.length === 0
                            ? "No plans for this job"
                            : "Choose a plan"}
                        </option>
                        {job?.plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title} · {p.language} · {p.questionCount} questions
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {job && job.plans.length === 0 && (
                    <p className="text-muted-foreground">
                      This job has no interview plan yet. Create one in the job before drafting.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Drafting reads every verified application page for the job (up to 2,500) and may
                    take a while. Duplicate candidates are counted once per job. No emails are sent
                    and no profiles are imported at this step.
                  </p>
                  <Button
                    className="h-auto max-w-full whitespace-normal text-center"
                    disabled={!job || !plan || !!busy}
                    onClick={() => void createDraft()}
                    data-testid="button-create-draft"
                  >
                    {busy === "create" ? "Reading Zoho applications..." : "Create draft snapshot"}
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">2. Saved campaigns</h3>
              {workspace.isFetching && (
                <span className="text-xs text-muted-foreground" role="status">
                  Updating
                </span>
              )}
            </div>
            {campaigns.length === 0 ? (
              <p
                className="rounded border border-dashed p-3 text-muted-foreground"
                data-testid="text-no-campaigns"
              >
                No campaigns saved yet. Drafts you create will appear here.
              </p>
            ) : (
              <ul className="space-y-2">
                {campaigns.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-testid={`button-select-campaign-${c.id}`}
                      onClick={() => {
                        setSelectedId(c.id === selectedId ? null : c.id);
                        setError("");
                        setNotice("");
                      }}
                      className={`flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border p-3 text-left transition-colors hover:bg-muted/50 ${c.id === selectedId ? "border-primary bg-primary/5" : ""}`}
                    >
                      <StateBadge state={c.state} id={`campaign-${c.id}`} />
                      <span className="min-w-0 flex-1 break-words font-medium">
                        {jobTitle(c.jobId) ?? `Zoho job ${c.externalJobId}`}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {planTitle(c.jobId, c.planId) ?? "plan"}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {c.recipientCount} recipients · {new Date(c.createdAt).toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {notice && (
        <p
          role="status"
          className="rounded border border-primary/40 bg-primary/5 p-3"
          data-testid="text-campaign-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/40 p-3 text-destructive"
          data-testid="text-campaign-error"
        >
          {error}
        </p>
      )}

      {selectedId && (
        <div
          className="min-w-0 space-y-4 border-t pt-3 sm:rounded sm:border sm:p-3"
          data-testid="panel-campaign-detail"
        >
          {detail.isLoading && (
            <div
              className="h-24 animate-pulse rounded bg-muted"
              role="status"
              aria-label="Loading campaign"
            />
          )}
          {detail.isError && (
            <div role="alert" className="space-y-2">
              <p className="text-destructive">
                {errorText(detail.error, "Campaign could not be loaded")}
              </p>
              <Button
                variant="outline"
                size="sm"
                data-testid="button-retry-detail"
                onClick={() => void detail.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {d && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words font-medium">
                    {jobTitle(d.campaign.jobId) ?? `Zoho job ${d.campaign.externalJobId}`}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {d.campaign.applicationCount} applications read · {d.campaign.recipientCount}{" "}
                    unique recipients
                    {running && " · progress refreshes automatically"}
                  </p>
                </div>
                <StateBadge state={d.campaign.state} id="campaign-detail" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Saved snapshot</p>
                <code
                  className="block break-all rounded bg-muted p-2 text-xs"
                  data-testid="text-snapshot-hash"
                >
                  {d.campaign.snapshotHash}
                </code>
              </div>
              <Counts campaign={d.campaign} />
              {d.recipients.some((r) => r.state === "sending" || r.state === "review_required") && (
                <div
                  className="space-y-2 rounded border border-amber-600/40 bg-amber-500/5 p-3"
                  role="status"
                  data-testid="delivery-review-notice"
                >
                  <h4 className="font-medium">Invitation delivery needs review</h4>
                  <p className="text-sm">
                    {
                      d.recipients.filter(
                        (r) => r.state === "sending" || r.state === "review_required",
                      ).length
                    }{" "}
                    recipient(s) have an unresolved send outcome. Inspect their saved evidence
                    below. A missing receipt does not prove the email was never sent.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This view is read-only. Lexy will not resend these invitations automatically.
                    Check the provider logs with your team before considering any further contact.
                  </p>
                </div>
              )}

              {d.campaign.state === "draft" && canContact && (
                <div className="space-y-3 rounded border border-amber-600/40 bg-amber-500/5 p-3">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={consent}
                      disabled={!!busy}
                      data-testid="checkbox-approve-campaign"
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I approve importing the eligible applicant profiles in this saved snapshot
                      into Lexy and sending real interview emails to those{" "}
                      {d.campaign.recipientCount} recipients. Sending runs automatically after
                      approval, even if I close this page. My team keeps control of hiring
                      decisions, and no Zoho stage will change.
                    </span>
                  </label>
                  <Button
                    className="h-auto max-w-full whitespace-normal text-center"
                    disabled={!consent || !!busy}
                    onClick={() => void act("approve", d)}
                    data-testid="button-approve-campaign"
                  >
                    {busy === "approve" ? "Recording approval..." : "Approve and send"}
                  </Button>
                </div>
              )}
              {(d.campaign.state === "draft" || d.campaign.state === "approved") && (
                <div className="space-y-1">
                  <Button
                    className="h-auto max-w-full whitespace-normal text-center"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void act("cancel", d)}
                    data-testid="button-cancel-campaign"
                  >
                    {busy === "cancel" ? "Cancelling..." : "Cancel campaign"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Emails already sending or sent cannot be recalled.
                  </p>
                </div>
              )}

              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">What each state means</summary>
                <ul className="mt-2 space-y-1">
                  {Object.entries(STATE_TEXT)
                    .filter(([k]) => k !== "approved")
                    .map(([k, v]) => (
                      <li key={k}>
                        <strong className="text-foreground">{v.label}:</strong> {v.meaning}
                      </li>
                    ))}
                </ul>
              </details>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Recipients</h4>
                {d.recipients.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-no-recipients">
                    No eligible recipients in this snapshot. No emails will be sent.
                  </p>
                ) : (
                  <ul className="max-h-96 space-y-2 overflow-auto">
                    {d.recipients.map((r) => (
                      <li
                        key={r.id}
                        className="min-w-0 space-y-1 rounded border p-2"
                        data-testid={`row-recipient-${r.id}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <StateBadge state={r.state} id={`recipient-${r.id}`} />
                          <span className="min-w-0 break-all font-mono text-xs">
                            App {r.applicationId} · Candidate {r.candidateId}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {stateInfo(r.state).meaning}
                        </p>
                        {r.reason && <p className="break-words text-xs">Reason: {r.reason}</p>}
                        <details
                          className="rounded bg-muted/40 p-2 text-xs"
                          open={
                            r.state === "sending" || r.state === "review_required"
                              ? true
                              : undefined
                          }
                          data-testid={`delivery-evidence-${r.id}`}
                        >
                          <summary className="cursor-pointer font-medium">
                            Saved invitation evidence
                          </summary>
                          {r.deliveryEvidence ? (
                            <dl className="mt-2 space-y-2">
                              <div>
                                <dt className="text-muted-foreground">Provider acceptance</dt>
                                <dd>
                                  {r.deliveryEvidence.acceptance === "recorded"
                                    ? "Recorded — not proof of inbox delivery."
                                    : r.deliveryEvidence.acceptance === "simulated"
                                      ? "Simulated — no real email sent."
                                      : "Unknown — no confirmed acceptance recorded."}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-muted-foreground">Saved provider reference</dt>
                                <dd className="break-all font-mono">
                                  {r.deliveryEvidence.providerMessageId ??
                                    "None recorded. This does not prove no send."}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-muted-foreground">
                                  Last recipient state update
                                </dt>
                                <dd>{r.deliveryEvidence.lastStateChangeAt}</dd>
                              </div>
                              <div>
                                <dt className="text-muted-foreground">Inbox delivery</dt>
                                <dd>Unverified. No live provider lookup is performed here.</dd>
                              </div>
                            </dl>
                          ) : (
                            <p className="mt-2">
                              Evidence unavailable. Do not infer delivery or retry safety.
                            </p>
                          )}
                          <p className="mt-2 text-muted-foreground">
                            Recipient reference: <span className="break-all font-mono">{r.id}</span>
                            . The state update time is not a confirmed send time.
                          </p>
                        </details>
                        {(r.interviewStatus || r.sessionId) && (
                          <p className="break-all text-xs">
                            {r.interviewStatus && (
                              <>Interview: {r.interviewStatus.replace(/_/g, " ")} </>
                            )}
                            {r.sessionId && (
                              <a
                                className="text-primary underline"
                                href={`/interviews/${r.sessionId}`}
                                data-testid={`link-session-${r.id}`}
                              >
                                Open session
                              </a>
                            )}
                          </p>
                        )}
                        <ZohoInterviewNote campaignId={d.campaign.id} recipientId={r.id} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <ZohoCampaignReviews campaignId={d.campaign.id} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
