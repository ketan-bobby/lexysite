import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPublicControlledOfferQueryKey,
  useGetPublicControlledOffer,
  useRespondToControlledOffer,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { publicOfferAvailability } from "@/lib/public-offer-availability";

export default function ControlledOfferPage() {
  const { token = "" } = useParams<{ token: string }>();
  return <ControlledOfferResponse key={token} token={token} />;
}

function ControlledOfferResponse({ token }: { token: string }) {
  const qc = useQueryClient();
  const q = useGetPublicControlledOffer(token, {
    query: {
      queryKey: getGetPublicControlledOfferQueryKey(token),
      retry: false,
      refetchInterval: 30_000,
      refetchOnWindowFocus: "always",
      refetchOnMount: "always",
    },
  });
  const m = useRespondToControlledOffer({});
  const [confirmation, setConfirmation] = useState<{
    choice: "accept" | "decline";
    version: number;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const o = q.data;
  const choice = confirmation?.version === o?.version ? confirmation?.choice : null;
  const availability = publicOfferAvailability(o, now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const shell = (children: React.ReactNode) => (
    <main
      className="mx-auto min-h-[100dvh] max-w-2xl space-y-4 px-4 py-8"
      data-testid="controlled-offer-public"
    >
      <header data-testid="controlled-offer-brand" className="pb-4">
        <img src={`${import.meta.env.BASE_URL}lexy-logo.png`} alt="Lexy" className="h-8 w-auto" />
      </header>
      {children}
    </main>
  );
  if (q.isLoading)
    return shell(
      <div
        className="h-40 animate-pulse rounded-lg bg-muted"
        data-testid="controlled-offer-public-loading"
      />,
    );
  const status = (q.error as { status?: number } | null)?.status;
  if (q.isError || !o)
    return shell(
      <div role="alert" className="space-y-2" data-testid="controlled-offer-public-error">
        <h1 className="text-xl font-semibold">
          {status === 404
            ? "This offer link is not valid"
            : status === 410
              ? "This offer has expired"
              : "Could not load the offer"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {status === 410
            ? "This offer can no longer be answered. Contact the employer if you need help."
            : status === 404
              ? "The link may be mistyped or withdrawn. Contact the employer who sent it."
              : "Please try again."}
        </p>
        {status !== 404 && status !== 410 && (
          <Button variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        )}
      </div>,
    );

  const t = o.terms;
  const usable = availability.canRespond;
  const submit = () => {
    // Recheck the real clock at click time, not only the last timer render.
    if (
      !choice ||
      !publicOfferAvailability(q.data, Date.now()).canRespond ||
      q.isFetching ||
      m.isPending
    )
      return;
    setError(null);
    m.mutate(
      { token, data: { decision: choice, ...(reason.trim() ? { reason: reason.trim() } : {}) } },
      {
        onSuccess: (r) => {
          qc.setQueryData(getGetPublicControlledOfferQueryKey(token), r);
          setConfirmation(null);
        },
        onError: (e) => {
          setError(e instanceof Error ? e.message : "The response failed.");
          q.refetch();
        },
      },
    );
  };
  return shell(
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">Offer from {t.employerName}</h1>
        <Badge variant="outline" data-testid="public-offer-status">
          {o.status}
        </Badge>
        {o.testOnly && (
          <Badge variant="destructive" data-testid="public-offer-test-only">
            TEST ONLY
          </Badge>
        )}
      </div>
      {o.testOnly && (
        <p className="text-sm text-muted-foreground">
          This is a test offer, not a real employment offer.
        </p>
      )}
      <section
        className="space-y-2 rounded-lg border border-border p-4"
        data-testid="public-offer-terms"
      >
        <p className="font-medium">{t.roleTitle}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Pay</dt>
          <dd>
            {t.amount} {t.currency} {t.frequency}
          </dd>
          <dt className="text-muted-foreground">Location</dt>
          <dd className="[overflow-wrap:anywhere]">{t.location}</dd>
          <dt className="text-muted-foreground">Start date</dt>
          <dd>{t.startDate}</dd>
          <dt className="text-muted-foreground">Respond by</dt>
          <dd>{new Date(t.expiresAt).toLocaleString()}</dd>
        </dl>
        <p className="whitespace-pre-wrap border-t border-border pt-2 text-sm [overflow-wrap:anywhere]">
          {t.letter}
        </p>
      </section>
      <Button variant="ghost" size="sm" className="print:hidden" onClick={() => window.print()}>
        Print offer
      </Button>
      {o.respondedAt && (
        <p role="status" className="text-sm" data-testid="public-offer-responded">
          Response recorded {new Date(o.respondedAt).toLocaleString()}.
          {o.responseReason ? ` Reason: ${o.responseReason}` : ""}
        </p>
      )}
      {availability.expired && (
        <p role="status" className="text-sm">
          This offer has expired and can no longer be answered.
        </p>
      )}
      {!usable && !availability.expired && o.status === "sent" && (
        <p role="status" className="text-sm">
          You cannot respond to this offer right now.
        </p>
      )}
      {usable && (
        <section className="space-y-2 print:hidden" aria-label="Respond">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={m.isPending || q.isFetching}
              onClick={() => setConfirmation({ choice: "accept", version: o.version })}
              data-testid="public-offer-accept"
            >
              Accept offer
            </Button>
            <Button
              variant="outline"
              disabled={m.isPending || q.isFetching}
              onClick={() => setConfirmation({ choice: "decline", version: o.version })}
              data-testid="public-offer-decline"
            >
              Decline offer
            </Button>
          </div>
          {choice && (
            <div
              className="space-y-2 rounded-md border border-border p-3 text-sm"
              role="alertdialog"
              aria-label="Confirm response"
            >
              <p>
                {choice === "accept"
                  ? "Confirm that you accept this offer? Your response is recorded."
                  : "Confirm that you decline this offer? Your response is recorded."}
              </p>
              <label className="block space-y-0.5 text-xs">
                <span>Optional note (up to 2000 characters)</span>
                <textarea
                  className="w-full rounded-md border border-border bg-background p-2 text-sm"
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={m.isPending || q.isFetching}
                  onClick={submit}
                  data-testid="public-offer-confirm"
                >
                  {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Confirm{" "}
                  {choice}
                </Button>
                <Button
                  variant="ghost"
                  disabled={m.isPending}
                  onClick={() => setConfirmation(null)}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error} You can retry.
            </p>
          )}
        </section>
      )}
    </>,
  );
}
