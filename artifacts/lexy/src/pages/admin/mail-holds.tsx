import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getListMailHoldsQueryKey,
  useListMailHolds,
  useReviewMailHold,
  type MailHold,
  type MailHoldReviewInputDisposition,
  type MailHoldReviewResult,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppLayout } from "@/components/layout/AppLayout";

const EVIDENCE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const reviewLabels: Record<string, string> = {
  keep_held: "Retained for investigation",
  closed_no_resend: "Review closed without resend",
};

/** Map any failure to fixed copy. Server messages are never rendered, so a
 *  failure body can never leak recipient, content or provider details. */
function describeFailure(error: unknown, action: "load" | "review"): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "This queue is restricted to platform administrators.";
  if (action === "review" && status === 400)
    return "The review was not recorded. Check the evidence reference and acknowledgement.";
  if (action === "review" && status === 404)
    return "This hold is no longer in the queue. Reload to see the current state.";
  return action === "load"
    ? "The mail hold queue could not be loaded. No cached entries are shown."
    : "The review outcome is unknown. Reload the queue before trying again; the hold itself was not released.";
}

export default function MailHolds() {
  const { user } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${user.tenantId ?? ""}` : "";
  return user?.role === "platform_admin" ? (
    <AppLayout>
      <Queue key={identity} identity={identity} />
    </AppLayout>
  ) : null;
}

function Queue({ identity }: { identity: string }) {
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const params = cursor ? { cursor } : undefined;
  const query = useListMailHolds(params, {
    query: {
      queryKey: [...getListMailHoldsQueryKey(params), identity],
      retry: false,
      staleTime: 0,
      gcTime: 60_000,
      refetchInterval: 30_000,
    },
  });
  const review = useReviewMailHold();

  const [selected, setSelected] = useState<{ operationId: string; version: string } | null>(null);
  const [disposition, setDisposition] = useState<MailHoldReviewInputDisposition | "">("");
  const [evidence, setEvidence] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [notice, setNotice] = useState<MailHoldReviewResult | null>(null);
  const [conflict, setConflict] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deniedAt, setDeniedAt] = useState<number | null>(null);

  const queryFailed = query.isError || query.failureReason != null;
  const failed = queryFailed || deniedAt !== null;
  const page = failed || !query.isFetchedAfterMount ? undefined : query.data;

  useEffect(() => {
    if (failed) {
      setSelected(null);
      setDisposition("");
      setEvidence("");
      setAcknowledged(false);
      setNotice(null);
    }
  }, [failed]);
  useEffect(() => {
    if (
      deniedAt !== null &&
      query.isSuccess &&
      !query.isFetching &&
      !queryFailed &&
      query.dataUpdatedAt > deniedAt
    )
      setDeniedAt(null);
  }, [deniedAt, query.isSuccess, query.isFetching, queryFailed, query.dataUpdatedAt]);

  const clearForm = () => {
    setSelected(null);
    setDisposition("");
    setEvidence("");
    setAcknowledged(false);
    setSubmitError(null);
  };
  const goFirstPage = () => {
    setCursors([undefined]);
    clearForm();
  };
  const reload = () => {
    setNotice(null);
    setConflict(false);
    clearForm();
    if (cursor) setCursors([undefined]);
    else void query.refetch();
  };

  // Only a selection whose version still matches the freshly loaded row is usable.
  const selectedRow: MailHold | undefined = selected
    ? page?.data.find((r) => r.operationId === selected.operationId)
    : undefined;
  const selectionStale =
    !!selected && !!page && (!selectedRow || selectedRow.version !== selected.version);

  const trimmed = evidence.trim();
  const evidenceValid =
    trimmed.length >= 3 && trimmed.length <= 120 && EVIDENCE_PATTERN.test(trimmed);
  const canSubmit =
    !!selectedRow &&
    !selectionStale &&
    !!disposition &&
    evidenceValid &&
    acknowledged &&
    !review.isPending &&
    !failed;

  const submit = () => {
    if (!canSubmit || !selectedRow || !disposition) return;
    setSubmitError(null);
    setNotice(null);
    review.mutate(
      {
        data: {
          operationId: selectedRow.operationId,
          version: selectedRow.version,
          disposition,
          evidenceReference: trimmed,
          acknowledgeNoResend: true,
        },
      },
      {
        onSuccess: (result) => {
          clearForm();
          setCursors([undefined]);
          setNotice(result.holdRetained === true ? result : null);
          if (result.holdRetained !== true)
            setSubmitError(
              "The server response did not confirm the hold was retained. Reload and verify.",
            );
          void queryClient.invalidateQueries({ queryKey: ["/api/platform/mail-holds"] });
        },
        onError: (error) => {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            setDeniedAt(Date.now());
            clearForm();
            setNotice(null);
            return;
          }
          if (error instanceof ApiError && error.status === 409) {
            clearForm();
            setConflict(true);
            setCursors([undefined]);
            void queryClient.invalidateQueries({ queryKey: ["/api/platform/mail-holds"] });
            return;
          }
          setSubmitError(describeFailure(error, "review"));
        },
      },
    );
  };

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mail Holds</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Recorded candidate replies, reminders and cadence emails whose outcome is not yet
            confirmed. Each retains its original send hold to prevent automatic retry of this
            attempt. "Pending" means the attempt may still be in flight or its outcome is uncertain.
            The reserved time is when Lexy reserved the attempt, not when anything was sent. Offer,
            erasure and outreach-specific ledgers are not covered here.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Metadata only: no recipient address, name, subject or body is shown. Reviewing never
            sends, retries, releases or marks an email delivered, and Lexy does not contact the
            email provider. Both review outcomes keep the original hold in place.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={reload}
          data-testid="button-refresh"
        >
          Refresh
        </Button>
      </div>

      {!failed && notice && (
        <div
          role="status"
          className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm"
          data-testid="status-review-recorded"
        >
          Review recorded ({reviewLabels[notice.disposition] ?? notice.disposition}, reference{" "}
          <span className="font-mono">{notice.reviewId}</span>). The original hold was retained.
          Nothing was sent or resent.
        </div>
      )}
      {!failed && conflict && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-signal-amber/50 p-4 text-sm"
          data-testid="alert-version-conflict"
        >
          <p>
            This hold changed since you read it, so your review was not recorded and your selection
            was cleared. The queue has been reloaded from the first page; read the current entry
            before reviewing again.
          </p>
          <Button size="sm" variant="outline" onClick={() => setConflict(false)}>
            Dismiss
          </Button>
        </div>
      )}

      {query.isLoading ? (
        <div role="status" aria-label="Loading mail holds" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer h-10 rounded-lg" />
          ))}
        </div>
      ) : failed ? (
        <div role="alert" className="space-y-3 rounded-lg border p-4">
          <p>{describeFailure(query.error ?? query.failureReason, "load")}</p>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={reload}
            data-testid="button-retry"
          >
            Try again
          </Button>
        </div>
      ) : page ? (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">Held email attempts awaiting human review</caption>
              <thead className="bg-muted/30">
                <tr>
                  <th className="p-3">Select</th>
                  <th className="p-3">Operation</th>
                  <th className="p-3">Kind</th>
                  <th className="p-3">Tenant / candidate ID</th>
                  <th className="p-3">Reserved at (not sent time)</th>
                  <th className="p-3">Last review</th>
                </tr>
              </thead>
              <tbody>
                {page.data.map((row) => {
                  const isSel =
                    selected?.operationId === row.operationId && selected.version === row.version;
                  return (
                    <tr
                      key={row.operationId}
                      className={isSel ? "border-t bg-primary/5" : "border-t"}
                    >
                      <td className="p-3">
                        <input
                          type="radio"
                          name="mail-hold"
                          aria-label={`Select hold ${row.operationId}`}
                          checked={isSel}
                          onChange={() => {
                            clearForm();
                            setNotice(null);
                            setConflict(false);
                            setSelected({ operationId: row.operationId, version: row.version });
                          }}
                          data-testid={`radio-hold-${row.operationId}`}
                        />
                      </td>
                      <td className="break-all p-3 font-mono text-xs">{row.operationId}</td>
                      <td className="p-3">{row.kind}</td>
                      <td className="break-all p-3 font-mono text-xs">
                        {row.tenantId}
                        <br />
                        {row.candidateId}
                      </td>
                      <td className="whitespace-nowrap p-3">
                        {new Date(row.reservedAt).toLocaleString()}
                      </td>
                      <td className="p-3">
                        {row.lastReview ? (
                          <>
                            {reviewLabels[row.lastReview]}
                            {row.lastReviewedAt && (
                              <span className="block text-muted-foreground">
                                {new Date(row.lastReviewedAt).toLocaleString()}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            Pending (in flight or uncertain)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {page.data.length === 0 && (
              <p className="p-6 text-muted-foreground">
                {cursors.length > 1
                  ? "No further eligible holds on this page."
                  : "No eligible recorded-email holds in this queue."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={cursors.length === 1 || query.isFetching}
              onClick={() => {
                clearForm();
                setCursors((c) => c.slice(0, -1));
              }}
              data-testid="button-previous-page"
            >
              Previous page
            </Button>
            <p className="text-sm text-muted-foreground" role="status">
              Page {cursors.length}
              {query.isFetching ? " · Updating…" : ""}
            </p>
            <Button
              disabled={!page.hasMore || !page.nextCursor || query.isFetching}
              onClick={() => {
                const next = page.nextCursor;
                if (next) {
                  clearForm();
                  setCursors((c) => [...c, next]);
                }
              }}
              data-testid="button-next-page"
            >
              Next page
            </Button>
          </div>

          {selected && (
            <form
              className="space-y-4 rounded-lg border p-4"
              aria-labelledby="review-heading"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <h2 id="review-heading" className="text-lg font-semibold">
                Review hold{" "}
                <span className="break-all font-mono text-sm">{selected.operationId}</span>
              </h2>
              {selectionStale ? (
                <div role="alert" className="space-y-2 text-sm">
                  <p>
                    This hold changed or left this page after you selected it. Read the current
                    entry and select again.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={goFirstPage}>
                    Clear selection
                  </Button>
                </div>
              ) : (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">
                      Decision (both keep the original hold)
                    </legend>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="disposition"
                        value="keep_held"
                        checked={disposition === "keep_held"}
                        onChange={() => setDisposition("keep_held")}
                        data-testid="radio-keep-held"
                      />
                      <span>
                        <span className="font-medium">Retain for investigation.</span> The hold
                        stays open for further review.
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="disposition"
                        value="closed_no_resend"
                        checked={disposition === "closed_no_resend"}
                        onChange={() => setDisposition("closed_no_resend")}
                        data-testid="radio-closed-no-resend"
                      />
                      <span>
                        <span className="font-medium">Close review without resending.</span> The
                        email will not be resent; the hold remains as the record.
                      </span>
                    </label>
                  </fieldset>
                  <div className="max-w-md space-y-1">
                    <label htmlFor="evidence-reference" className="text-sm font-medium">
                      Evidence reference
                    </label>
                    <Input
                      id="evidence-reference"
                      value={evidence}
                      maxLength={120}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="e.g. TICKET-4821"
                      aria-describedby="evidence-help"
                      aria-invalid={evidence.length > 0 && !evidenceValid}
                      onChange={(e) => setEvidence(e.target.value)}
                      data-testid="input-evidence-reference"
                    />
                    <p id="evidence-help" className="text-xs text-muted-foreground">
                      A ticket or receipt ID only, 3-120 characters of letters, digits and _ . : -.
                      Never credentials, URLs, message content or personal data.
                    </p>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      data-testid="checkbox-acknowledge"
                    />
                    <span>
                      I understand this review does not send, retry, release or confirm delivery of
                      any email, and the original hold is retained.
                    </span>
                  </label>
                  {submitError && (
                    <p role="alert" className="text-sm text-destructive">
                      {submitError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={!canSubmit} data-testid="button-record-review">
                      {review.isPending ? "Recording…" : "Record review"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={review.isPending}
                      onClick={clearForm}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </form>
          )}
        </>
      ) : null}
    </div>
  );
}
