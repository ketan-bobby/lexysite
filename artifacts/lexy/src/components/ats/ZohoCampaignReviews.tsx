import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetZohoCampaignApplicantReviewQueryKey,
  getGetZohoCampaignReviewQueueQueryKey,
  getZohoCampaignApplicantReview,
  getZohoCampaignReviewQueue,
  getZohoStageHandoff,
  recordZohoCampaignApplicantReview,
} from "@workspace/api-client-react";
import type {
  ZohoCampaignApplicantReview,
  ZohoCampaignReviewInputDecision,
  ZohoCampaignReviewQueue,
  ZohoCampaignReviewRow,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { useZohoRequestScope } from "./useZohoRequestScope";
import { displayScore } from "@/lib/score-display";
import { Button } from "@/components/ui/button";
import { ZohoStageHandoff } from "@/components/ats/ZohoStageHandoff";
import { ZohoInterviewNote } from "./ZohoInterviewNote";
import { prepareZohoReviewDownload } from "@/lib/zoho-review-download";
import { prepareZohoReviewExport } from "@workspace/api-client-react";
import { saveCandidateDataDownload } from "@/lib/candidate-data-download";

const DECISION_TEXT: Record<string, string> = {
  advance: "Advance to next-round review",
  hold: "Hold",
  decline: "Do not advance",
};
const decisionLabel = (d: string) => DECISION_TEXT[d] ?? d.replace(/_/g, " ");
const REASON_MIN = 10;
const REASON_MAX = 2000;

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isQueue(v: unknown, id: string): v is ZohoCampaignReviewQueue {
  const q = v as ZohoCampaignReviewQueue | null;
  return (
    !!q &&
    q.campaignId === id &&
    Array.isArray(q.rows) &&
    q.rows.every((r) => typeof r?.recipientId === "string")
  );
}
function isReview(v: unknown, id: string, rid: string): v is ZohoCampaignApplicantReview {
  const r = v as ZohoCampaignApplicantReview | null;
  return (
    !!r &&
    r.campaignId === id &&
    r.recipientId === rid &&
    typeof r.revision === "string" &&
    !!r.assessment &&
    Array.isArray(r.answers) &&
    Array.isArray(r.history)
  );
}
const canOpen = (r: ZohoCampaignReviewRow) => !!r.sessionStatus && !!r.candidateName;
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

function DecisionBadge({
  decision,
  stale,
  id,
}: {
  decision: string | null;
  stale: boolean;
  id: string;
}) {
  if (!decision) {
    return (
      <span
        data-testid={`status-decision-${id}`}
        className="inline-flex max-w-full whitespace-normal break-words rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs text-muted-foreground"
      >
        No human decision
      </span>
    );
  }
  return (
    <span
      data-testid={`status-decision-${id}`}
      className={`inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 whitespace-normal break-words rounded-full border px-2 py-0.5 text-xs font-medium ${stale ? "border-amber-600/50 text-amber-700 line-through decoration-1 dark:text-amber-400" : "border-primary/50 text-primary"}`}
    >
      Human: {decisionLabel(decision)}
      {stale && <span className="no-underline">(not current)</span>}
    </span>
  );
}

function List({ title, items, testid }: { title: string; items: string[]; testid: string }) {
  if (!items.length) return null;
  return (
    <div className="min-w-0" data-testid={testid}>
      <p className="text-xs text-muted-foreground">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 sm:pl-5">
        {items.map((s, i) => (
          <li key={i} className="break-words">
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Local, human-only review of campaign interview evidence. Never writes to Zoho or contacts candidates. */
export function ZohoCampaignReviews({ campaignId }: { campaignId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const identity = `${user?.id}:${user?.tenantId}:${user?.role}:${campaignId}`;

  const [recipientId, setRecipientId] = useState<string | null>(null);
  const isCurrentView = useZohoRequestScope(`${identity}:${recipientId}`);
  const [decision, setDecision] = useState<ZohoCampaignReviewInputDecision | "">("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIdRef = useRef<{ key: string; id: string } | null>(null);
  const seenRevision = useRef<string | null>(null);

  const resetForm = () => {
    setDownloading(false);
    setDecision("");
    setReason("");
    setConfirm(false);
    setError("");
    setNotice("");
    requestIdRef.current = null;
    seenRevision.current = null;
  };
  useEffect(() => {
    setRecipientId(null);
    resetForm();
    setSaving(false);
  }, [identity]);
  useEffect(() => {
    resetForm();
    setSaving(false);
  }, [recipientId]);

  const queueKey = [...getGetZohoCampaignReviewQueueQueryKey(campaignId), identity];
  const queue = useQuery({
    queryKey: queueKey,
    queryFn: async ({ signal }) => {
      const body = await getZohoCampaignReviewQueue(campaignId, { signal, cache: "no-store" });
      if (!isQueue(body, campaignId))
        throw new Error("Review queue returned an unexpected response.");
      return body;
    },
    enabled: !!user,
    retry: false,
    staleTime: 0,
    refetchInterval: 10000,
  });
  const detailKey = [
    ...getGetZohoCampaignApplicantReviewQueryKey(campaignId, recipientId ?? ""),
    identity,
  ];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      const body = await getZohoCampaignApplicantReview(campaignId, recipientId!, {
        signal,
        cache: "no-store",
      });
      if (!isReview(body, campaignId, recipientId!))
        throw new Error("Applicant evidence returned an unexpected response.");
      return body;
    },
    enabled: !!user && !!recipientId,
    retry: false,
    staleTime: 0,
    refetchInterval: 20000,
  });

  const r = detail.data;
  // Evidence revision changed under the reviewer: require confirmation again. Reason text is kept.
  useEffect(() => {
    if (!r) return;
    if (seenRevision.current && seenRevision.current !== r.revision) {
      setConfirm(false);
      requestIdRef.current = null;
      setNotice(
        "Evidence or decisions changed since you opened this. Review again and re-confirm before saving.",
      );
    }
    seenRevision.current = r.revision;
  }, [r?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  const complete = !!r && r.reviewable;
  const canSave = complete && !!decision && reasonOk && confirm && !saving && !downloading;
  const latest = r?.history[0] ?? null;

  async function downloadReview() {
    if (!r || downloading || saving || user?.role !== "tenant_admin") return;
    const stillCurrent = isCurrentView;
    setDownloading(true);
    setError("");
    setNotice("");
    try {
      const file = await prepareZohoReviewDownload({
        campaignId,
        recipientId: r.recipientId,
        expectedRevision: r.revision,
        isCurrentView: stillCurrent,
        readReview: () =>
          getZohoCampaignApplicantReview(campaignId, r.recipientId, { cache: "no-store" }),
        readHandoff: () => getZohoStageHandoff(campaignId, r.recipientId, { cache: "no-store" }),
        recordPreparation: (input) => prepareZohoReviewExport(campaignId, r.recipientId, input),
      });
      if (!stillCurrent()) return;
      saveCandidateDataDownload(file);
      setNotice(
        "Reviewed handoff download started. Preparation was audited; file delivery is unverified and nothing changed in Zoho.",
      );
    } catch (cause) {
      if (stillCurrent())
        setError(errorText(cause, "The reviewed handoff could not be downloaded"));
    } finally {
      if (stillCurrent()) setDownloading(false);
    }
  }

  async function save() {
    if (!r || !canSave || !decision) return;
    const stillCurrent = isCurrentView;
    const payload = { decision, reason: trimmed, expectedRevision: r.revision };
    const key = `${identity}:${r.recipientId}:${JSON.stringify(payload)}`;
    if (requestIdRef.current?.key !== key) requestIdRef.current = { key, id: crypto.randomUUID() };
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = await recordZohoCampaignApplicantReview(campaignId, r.recipientId, {
        ...payload,
        requestId: requestIdRef.current.id,
        confirm: true,
      });
      if (!stillCurrent()) return;
      if (!isReview(body, campaignId, r.recipientId))
        throw new Error("Save response was not recognized. Refresh before retrying.");
      requestIdRef.current = null;
      seenRevision.current = body.revision;
      setDecision("");
      setReason("");
      setConfirm(false);
      qc.setQueryData(detailKey, body);
      setNotice(
        "Local decision recorded in Lexy. Nothing changed in Zoho and no one was contacted. Carry out any next-round action in your ATS yourself.",
      );
    } catch (cause) {
      if (!stillCurrent()) return;
      if (cause instanceof ApiError && cause.status === 409) {
        requestIdRef.current = null;
        setConfirm(false);
        setError(
          "Evidence or decision history changed before your save. Nothing was overwritten. Review the refreshed evidence and confirm again.",
        );
      } else {
        setError(errorText(cause, "Decision was not recorded. Retrying keeps the same request"));
      }
    } finally {
      if (stillCurrent()) {
        setSaving(false);
        await Promise.all([
          qc.invalidateQueries({ queryKey: detailKey }),
          qc.invalidateQueries({ queryKey: queueKey }),
        ]);
      }
    }
  }

  const rows = queue.data?.rows ?? [];

  return (
    <section
      className="min-w-0 space-y-4 border-t pt-3 sm:rounded sm:border sm:p-3"
      aria-label="Interview evidence review"
      data-testid="section-campaign-reviews"
    >
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Human decision, local to Lexy
        </p>
        <h4 className="text-sm font-medium">Review interview evidence</h4>
        <p
          className="rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs"
          data-testid="text-review-scope"
        >
          Decisions here are recorded only in Lexy. They do not move Zoho stages, write to Zoho or
          email the candidate. Your team must carry out any next-round action separately in your
          ATS. AI assessment is unapproved advice for this job only.
        </p>
      </header>

      {queue.isLoading && (
        <div className="space-y-2" role="status" aria-label="Loading review queue">
          <div className="h-12 animate-pulse rounded bg-muted" />
          <div className="h-12 animate-pulse rounded bg-muted" />
        </div>
      )}
      {queue.isError && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="break-words text-destructive" data-testid="text-review-queue-error">
            {errorText(queue.error, "Review queue could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-retry-review-queue"
            onClick={() => void queue.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {queue.data && rows.length === 0 && (
        <p
          className="rounded border border-dashed p-3 text-muted-foreground"
          data-testid="text-no-reviews"
        >
          No interview evidence yet. Candidates appear here once they start their interview.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="max-h-96 space-y-2 overflow-auto" data-testid="list-review-queue">
          {rows.map((row) => {
            const openable = canOpen(row);
            const selected = row.recipientId === recipientId;
            return (
              <li key={row.recipientId}>
                <button
                  type="button"
                  disabled={!openable}
                  data-testid={`row-review-${row.recipientId}`}
                  onClick={() => setRecipientId(selected ? null : row.recipientId)}
                  className={`flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded border p-2 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60 ${selected ? "border-primary bg-primary/5" : ""}`}
                >
                  <span
                    className="w-full min-w-0 break-words font-medium sm:w-auto sm:flex-1"
                    data-testid={`text-review-name-${row.recipientId}`}
                  >
                    {row.candidateName ?? (
                      <span className="font-normal text-muted-foreground">
                        Name withheld, no usable evidence
                      </span>
                    )}
                  </span>
                  <span
                    className="font-mono text-sm tabular-nums"
                    title="Interview score for this job (AI, unapproved)"
                    data-testid={`text-review-score-${row.recipientId}`}
                  >
                    {displayScore(row.score)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.sessionStatus
                      ? `Interview ${row.sessionStatus.replace(/_/g, " ")}`
                      : "No interview session"}
                  </span>
                  <DecisionBadge
                    decision={row.decision}
                    stale={row.decisionStale}
                    id={row.recipientId}
                  />
                  <span className="w-full break-all font-mono text-[11px] text-muted-foreground">
                    App {row.applicationId} · Candidate {row.externalCandidateId}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {recipientId && (
        <div
          className="min-w-0 space-y-4 border-t pt-3 sm:rounded sm:border sm:p-3"
          data-testid="panel-applicant-review"
        >
          {detail.isLoading && (
            <div
              className="h-32 animate-pulse rounded bg-muted"
              role="status"
              aria-label="Loading evidence"
            />
          )}
          {detail.isError && (
            <div role="alert" className="space-y-2">
              <p className="break-words text-destructive">
                {errorText(detail.error, "Evidence could not be loaded")}
              </p>
              <Button
                variant="outline"
                size="sm"
                data-testid="button-retry-review-detail"
                onClick={() => void detail.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {r && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h5 className="break-words font-medium" data-testid="text-review-candidate">
                    {r.candidateName}
                  </h5>
                  <p className="break-words text-xs text-muted-foreground">
                    Interview {r.sessionStatus.replace(/_/g, " ")} · completed {fmt(r.completedAt)}
                  </p>
                </div>
                <a
                  className="text-xs text-primary underline"
                  href={`/interviews/${r.sessionId}`}
                  data-testid="link-review-session"
                >
                  Open session
                </a>
              </div>

              <div className="space-y-1">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-download-reviewed-handoff"
                  disabled={
                    user?.role !== "tenant_admin" ||
                    !r.reviewable ||
                    r.decisionStale ||
                    !latest?.evidenceCurrent ||
                    saving ||
                    downloading ||
                    detail.isError ||
                    detail.isFetching
                  }
                  onClick={() => void downloadReview()}
                >
                  {downloading ? "Preparing handoff…" : "Download reviewed handoff"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Requires a saved, current human decision. Preparation is audited. JSON snapshot
                  for manual ATS review only—not a Zoho update or offer approval. Keep the
                  downloaded file confidential.
                </p>
              </div>

              <div
                className="min-w-0 space-y-2 rounded bg-muted/30 p-2 sm:border sm:p-3"
                data-testid="panel-ai-assessment"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    AI assessment, advisory only
                  </p>
                  <span
                    className="font-mono text-lg tabular-nums"
                    data-testid="text-assessment-score"
                  >
                    {displayScore(r.assessment.score)}
                  </span>
                </div>
                {r.assessment.summary == null &&
                r.assessment.recommendation == null &&
                r.assessment.score == null ? (
                  <p className="text-muted-foreground" data-testid="text-assessment-missing">
                    No AI assessment is available for this interview. Review the answers below
                    directly.
                  </p>
                ) : (
                  <>
                    {r.assessment.summary && <p className="break-words">{r.assessment.summary}</p>}
                    {r.assessment.recommendation && (
                      <p className="break-words text-sm" data-testid="text-ai-recommendation">
                        <span className="text-muted-foreground">
                          AI suggestion (not a hiring decision):{" "}
                        </span>
                        {r.assessment.recommendation}
                      </p>
                    )}
                  </>
                )}
                <List title="Strengths" items={r.assessment.strengths} testid="list-strengths" />
                <List
                  title="Development areas"
                  items={r.assessment.developmentAreas}
                  testid="list-development"
                />
                <List title="Concerns" items={r.assessment.concerns} testid="list-concerns" />
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Questions and answers</p>
                {r.answers.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-no-answers">
                    No recorded answers for this interview.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {r.answers.map((a, i) => (
                      <li
                        key={i}
                        className="min-w-0 space-y-1 rounded border p-2 [overflow-wrap:anywhere]"
                        data-testid={`row-answer-${i}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 flex-1 break-words font-medium">
                            {i + 1}. {a.question}
                          </p>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {displayScore(a.score)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {a.answer || (
                            <span className="text-muted-foreground">No answer given.</span>
                          )}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {r.answersTruncated && (
                  <p className="text-xs text-muted-foreground" data-testid="text-answers-truncated">
                    Only part of the answers is shown here. Open the session for the full record.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Human decision history</p>
                {r.decisionStale && (
                  <p
                    className="rounded border border-amber-600/50 bg-amber-500/5 p-2 text-xs"
                    data-testid="text-decision-stale"
                  >
                    The latest decision was made on earlier evidence and is not current. Review
                    again before acting on it.
                  </p>
                )}
                {r.history.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="text-no-history">
                    No human decision recorded yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {r.history.map((h) => (
                      <li
                        key={h.id}
                        className={`min-w-0 space-y-1 rounded border p-2 [overflow-wrap:anywhere] ${h.evidenceCurrent ? "" : "opacity-75"}`}
                        data-testid={`row-history-${h.id}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <DecisionBadge
                            decision={h.decision}
                            stale={!h.evidenceCurrent}
                            id={`history-${h.id}`}
                          />
                          <span className="break-all text-xs text-muted-foreground">
                            {h.reviewedBy} · {fmt(h.createdAt)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm">{h.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form
                className="min-w-0 space-y-3 border-t border-primary/30 pt-3 sm:rounded sm:border sm:p-3"
                data-testid="form-review-decision"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <p className="font-medium">
                  {latest ? "Record a revised decision" : "Record your decision"}
                </p>
                {latest && (
                  <p className="text-xs text-muted-foreground">
                    A revised decision is added to the history. Earlier decisions stay as recorded.
                  </p>
                )}
                {!complete && (
                  <p className="text-xs text-destructive" data-testid="text-review-incomplete">
                    This interview is not complete, so a decision cannot be saved yet.
                  </p>
                )}
                <label className="block min-w-0 space-y-1">
                  <span className="text-xs text-muted-foreground">Decision</span>
                  <select
                    className="block w-full min-w-0 rounded border bg-background p-2"
                    value={decision}
                    disabled={!complete || saving}
                    data-testid="select-review-decision"
                    onChange={(e) => {
                      setDecision(e.target.value as ZohoCampaignReviewInputDecision | "");
                      setConfirm(false);
                    }}
                  >
                    <option value="">Choose a decision</option>
                    <option value="advance">{DECISION_TEXT.advance}</option>
                    <option value="hold">{DECISION_TEXT.hold}</option>
                    <option value="decline">{DECISION_TEXT.decline}</option>
                  </select>
                </label>
                <label className="block min-w-0 space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Job-related reason (required, {REASON_MIN} to {REASON_MAX} characters)
                  </span>
                  <textarea
                    className="block min-h-24 w-full min-w-0 rounded border bg-background p-2"
                    value={reason}
                    maxLength={REASON_MAX}
                    disabled={!complete || saving}
                    data-testid="input-review-reason"
                    onChange={(e) => {
                      setReason(e.target.value);
                      setConfirm(false);
                    }}
                  />
                  <span
                    className={`text-xs ${reason && !reasonOk ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {trimmed.length} / {REASON_MAX}
                  </span>
                </label>
                <label className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={confirm}
                    disabled={!complete || saving}
                    data-testid="checkbox-review-confirm"
                    onChange={(e) => setConfirm(e.target.checked)}
                  />
                  <span className="min-w-0 break-words text-sm">
                    I reviewed this interview evidence myself. This is a local human decision in
                    Lexy only. It does not change Zoho, contact the candidate or approve the AI
                    assessment. I will carry out any next-round action separately.
                  </span>
                </label>
                <Button
                  type="submit"
                  className="h-auto max-w-full whitespace-normal text-center"
                  disabled={!canSave}
                  data-testid="button-save-review"
                >
                  {saving ? "Recording decision..." : "Record local decision"}
                </Button>
              </form>
              <ZohoInterviewNote
                campaignId={campaignId}
                recipientId={r.recipientId}
                allowAssessment
              />
              <ZohoStageHandoff
                key={r.recipientId}
                campaignId={campaignId}
                recipientId={r.recipientId}
                reviewRevision={r.revision}
              />
            </>
          )}
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="break-words rounded border border-primary/40 bg-primary/5 p-3"
          data-testid="text-review-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="break-words rounded border border-destructive/40 p-3 text-destructive"
          data-testid="text-review-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
