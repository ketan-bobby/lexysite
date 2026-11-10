import { useCallback, useEffect, useState } from "react";
import { useSearch, useLocation, Link } from "wouter";
import { useQueries } from "@tanstack/react-query";
import {
  getEmployerOfferInbox,
  useGetEmployerOfferInbox,
  useGetEmployerOfferInboxItem,
  getGetEmployerOfferInboxItemQueryKey,
  getGetEmployerOfferInboxQueryKey,
  type OfferInboxEntry,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WorkflowControlledOffer } from "@/components/jobs/WorkflowControlledOffer";
import { WorkflowOfferRouting } from "@/components/jobs/WorkflowOfferRouting";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { offerInboxNeedsAction } from "@/lib/offer-inbox-action";
import { offerInboxPages, refreshOfferInboxPages } from "@/lib/offer-inbox-pages";

const PAGE = 25;
const POLL = 15000;
const ACTION: Record<string, string> = {
  prepare: "Prepare offer",
  review: "Review and approve",
  send: "Ready to send",
  monitor: "Monitor response",
  external_handoff: "Manual external handoff",
  blocked: "Blocked",
};
type Filter = "pending" | "all";

const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;
const errMsg = (e: unknown) => (e as { message?: string } | null)?.message ?? "Request failed.";

function Row({ e, active, onPick }: { e: OfferInboxEntry; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active}
      data-testid={`offer-inbox-row-${e.workflowId}`}
      className={`block w-full min-w-0 rounded-lg border p-3 text-left transition-colors ${
        active ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-foreground/5"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{e.candidateName}</span>
        {e.testOnly && <Badge variant="destructive">TEST ONLY</Badge>}
        <Badge variant="outline">{e.mode === "native" ? "Native" : "External"}</Badge>
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {e.jobTitle} · {e.employerName}
      </p>
      <p className="mt-1 text-xs">
        <span className="font-medium">{ACTION[e.nextAction] ?? e.nextAction}</span>
        <span className="text-muted-foreground"> · {e.status.replace(/_/g, " ")}</span>
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {e.roles.join(", ")} · updated {new Date(e.updatedAt).toLocaleString()}
      </p>
      {e.warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-destructive">
          {e.warnings.map((w, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {w}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

function Detail({ id, onGone, onClose }: { id: string; onGone: () => void; onClose: () => void }) {
  const q = useGetEmployerOfferInboxItem(id, {
    query: {
      enabled: !!id,
      queryKey: getGetEmployerOfferInboxItemQueryKey(id),
      refetchInterval: POLL,
      retry: (n, e) => errStatus(e) !== 404 && errStatus(e) !== 403 && n < 1,
    },
  });
  const gone = errStatus(q.error) === 404;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  if (q.isLoading)
    return (
      <div
        className="h-40 animate-pulse rounded-lg bg-muted"
        data-testid="offer-inbox-detail-loading"
      />
    );
  if (gone)
    return (
      <p role="alert" className="text-sm">
        This offer is no longer assigned to you or was removed.
      </p>
    );
  if (q.isError || !q.data)
    return (
      <div role="alert" className="space-y-2 text-sm" data-testid="offer-inbox-detail-error">
        <p className="text-destructive">Could not load this offer. {errMsg(q.error)}</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );
  const { entry, routing } = q.data;
  const pk = routing.packet;
  return (
    <div className="min-w-0 space-y-3" data-testid="offer-inbox-detail">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{entry.candidateName}</h2>
          <p className="text-xs text-muted-foreground">
            {entry.jobTitle} · {entry.employerName}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} className="lg:hidden">
          Close
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(entry.testOnly || pk?.testOnly) && <Badge variant="destructive">TEST ONLY</Badge>}
        <Badge variant="outline">{ACTION[entry.nextAction]}</Badge>
        <Badge variant="outline">Your roles: {entry.roles.join(", ")}</Badge>
      </div>
      {entry.warnings.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-destructive/40 p-2 text-xs text-destructive">
          {entry.warnings.map((w, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {w}
            </li>
          ))}
        </ul>
      )}
      {(entry.testOnly || pk?.testOnly) && (
        <p className="text-xs font-semibold text-destructive">
          TEST ONLY: this is a test offer, not a real employment offer.
        </p>
      )}
      {pk && (
        <section
          className="space-y-1 rounded-lg border border-border bg-card p-3 text-xs"
          data-testid="offer-inbox-evidence"
        >
          <p className="text-sm font-medium">Hiring reason and evidence</p>
          <p className="[overflow-wrap:anywhere]">
            Human decision: {pk.decision} by {pk.decisionBy} on{" "}
            {new Date(pk.decisionAt).toLocaleString()}.
          </p>
          <p className="[overflow-wrap:anywhere]">Reason: {pk.decisionReason}</p>
          <ul className="space-y-0.5">
            {pk.evidence.map((e) => (
              <li key={e.label} className="[overflow-wrap:anywhere]">
                {e.label} ({e.status.replace("_", " ")}): {e.evidence ?? "no evidence recorded"}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Recorded workflow evidence may be incomplete. Acceptance of an offer is not confirmed
            employment and creates no fee.
          </p>
        </section>
      )}
      <Link
        href={`/jobs/${entry.jobId}`}
        className="inline-block text-sm underline"
        data-testid="offer-inbox-open-work-order"
      >
        Open work order
      </Link>
      {entry.mode === "native" ? (
        <WorkflowControlledOffer wf={{ id: entry.workflowId }} jobId={entry.jobId} />
      ) : (
        <p
          className="rounded-md border border-border p-2 text-xs"
          data-testid="offer-inbox-external"
        >
          External employer handoff. Lexy has no native offer controls here and is not connected to
          the employer's ATS; the handoff is manual. Use the packet download below.
        </p>
      )}
      <WorkflowOfferRouting wf={{ id: entry.workflowId }} jobId={entry.jobId} />
    </div>
  );
}

export default function OfferInboxPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const selected = new URLSearchParams(search).get("workflow") ?? "";
  const [filter, setFilter] = useState<Filter>("pending");
  const [term, setTerm] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [paginationNotice, setPaginationNotice] = useState(false);

  const q = useGetEmployerOfferInbox(
    { limit: PAGE },
    {
      query: { queryKey: getGetEmployerOfferInboxQueryKey({ limit: PAGE }), refetchInterval: POLL },
    },
  );
  const pageQs = useQueries({
    queries: cursors.map((c) => {
      const params = { limit: PAGE, cursor: c };
      return {
        queryKey: getGetEmployerOfferInboxQueryKey(params),
        queryFn: ({ signal }: { signal: AbortSignal }) => getEmployerOfferInbox(params, { signal }),
        refetchInterval: POLL,
      };
    }),
  });
  const lastQ = pageQs.length ? pageQs[pageQs.length - 1] : null;
  const moreBusy = !!lastQ && lastQ.isLoading;
  const moreErr = pageQs.find((p) => p.isError);
  const {
    rows,
    nextCursor: cursor,
    accessDenied,
    accessError,
    canShowDetail,
    paginationChanged,
    paginationLoop,
    retainedCursorCount,
  } = offerInboxPages(q, pageQs, cursors);

  useEffect(() => {
    // Never erase a known denial merely because its page has become obsolete.
    if (!paginationChanged || accessDenied || q.isError) return;
    setPaginationNotice(true);
    setCursors((current) =>
      current.length > retainedCursorCount ? current.slice(0, retainedCursorCount) : current,
    );
  }, [paginationChanged, retainedCursorCount, accessDenied, q.isError]);

  const shown = rows.filter((e) => {
    if (filter === "pending" && !offerInboxNeedsAction(e.nextAction)) return false;
    const t = term.trim().toLowerCase();
    return !t || `${e.candidateName} ${e.jobTitle} ${e.employerName}`.toLowerCase().includes(t);
  });

  const select = useCallback(
    (id: string | null) =>
      navigate(id ? `/offer-inbox?workflow=${encodeURIComponent(id)}` : "/offer-inbox", {
        replace: !id,
      }),
    [navigate],
  );
  const onGone = useCallback(() => {
    q.refetch();
    navigate("/offer-inbox", { replace: true });
  }, [selected, navigate, q]);

  const refresh = () =>
    refreshOfferInboxPages(
      () => q.refetch(),
      () => {
        setCursors([]);
        setPaginationNotice(false);
      },
      q.dataUpdatedAt,
    );
  const loadMore = () => {
    if (cursor) {
      setCursors((current) => {
        const prefix = current.slice(0, retainedCursorCount);
        return prefix.includes(cursor) ? prefix : [...prefix, cursor];
      });
    }
  };

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl min-w-0 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Offer inbox</h1>
            <p className="text-sm text-muted-foreground">
              Offers where you are an assigned owner, approver, sender or contact. Nothing is sent
              automatically.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={q.isFetching}
            data-testid="offer-inbox-refresh"
          >
            {q.isFetching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </header>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className={`min-w-0 space-y-2 ${selected ? "hidden lg:block" : ""}`}>
            <div className="flex flex-wrap gap-2">
              {(["pending", "all"] as const).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={filter === f ? "default" : "outline"}
                  onClick={() => setFilter(f)}
                  data-testid={`offer-inbox-filter-${f}`}
                >
                  {f === "pending" ? "Needs action" : "All loaded"}
                </Button>
              ))}
            </div>
            <label className="relative block">
              <span className="sr-only">Search loaded offers</span>
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search loaded rows"
                className="w-full rounded-md border border-border bg-background p-2 pl-8 text-sm"
                data-testid="offer-inbox-search"
              />
            </label>
            <p className="text-xs text-muted-foreground" role="status">
              Showing {shown.length} of {rows.length} loaded{cursor ? "; more available" : ""}.
            </p>

            {!q.isLoading && !q.isError && !accessDenied && paginationNotice && (
              <p
                role="status"
                className="text-xs text-muted-foreground"
                data-testid="offer-inbox-pagination-changed"
              >
                Offer ordering changed. Later pages were reset to avoid missing offers. Use Load
                more, if available, to continue from the current results. Your filters and selected
                offer have not changed.
              </p>
            )}
            {!q.isLoading && !q.isError && !accessDenied && paginationLoop && (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="offer-inbox-pagination-error"
              >
                The next page repeated an earlier cursor. Refresh the inbox before continuing; this
                is not confirmation that every offer has been loaded.
              </p>
            )}
            {!q.isLoading && !q.isError && !accessDenied && moreErr && (
              <div
                role="alert"
                className="space-y-1 text-xs text-destructive"
                data-testid="offer-inbox-page-error"
              >
                <p>
                  A loaded page could not be refreshed. Its cached offers are hidden until a
                  successful retry. {errMsg(moreErr.error)}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => pageQs.forEach((p) => p.isError && p.refetch())}
                >
                  Retry page
                </Button>
              </div>
            )}
            {q.isLoading && !accessDenied ? (
              <div className="space-y-2" data-testid="offer-inbox-loading">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : q.isError || accessDenied ? (
              <div role="alert" className="space-y-2 text-sm" data-testid="offer-inbox-error">
                <p className="text-destructive">
                  Could not load your offers. {errMsg(accessError ?? q.error)}
                </p>
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              </div>
            ) : rows.length === 0 && !moreErr && !cursor && !paginationLoop ? (
              <div
                className="rounded-lg border border-dashed border-border p-6 text-sm"
                data-testid="offer-inbox-empty"
              >
                <p className="font-medium">No offers assigned to you.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Offers appear when an employer admin names you owner, approver, sender or contact.
                  Being an admin does not show every offer in the tenant.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {shown.length === 0 && !moreErr && (
                  <p className="text-sm text-muted-foreground" data-testid="offer-inbox-nomatch">
                    No loaded rows match.{cursor ? " Load more to look further." : ""}
                  </p>
                )}
                {shown.map((e) => (
                  <Row
                    key={e.workflowId}
                    e={e}
                    active={e.workflowId === selected}
                    onPick={() => select(e.workflowId)}
                  />
                ))}
                {cursor && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={moreBusy}
                    onClick={loadMore}
                    data-testid="offer-inbox-load-more"
                  >
                    {moreBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Load more
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className={`min-w-0 ${selected ? "" : "hidden lg:block"}`}>
            {selected && q.isLoading && !accessDenied ? (
              <div
                className="h-40 animate-pulse rounded-lg bg-muted"
                role="status"
                aria-label="Loading offer access"
              />
            ) : selected && canShowDetail ? (
              <div className="min-w-0 rounded-xl border border-border bg-card/50 p-3 sm:p-4">
                <Detail key={selected} id={selected} onGone={onGone} onClose={() => select(null)} />
              </div>
            ) : selected ? (
              <div role="alert" className="space-y-2 rounded-lg border border-border p-4 text-sm">
                <p>Offer access could not be confirmed. Cached offer details are hidden.</p>
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry access
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
                Select an offer to see the hiring reason, evidence and available actions.
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
