import type { SourcingControlView } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

/** Integer USD micro units to a dollar string, keeping sub-cent evidence (2 to 6 decimals). */
export function usdMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}.${frac.padEnd(2, "0")}`;
}

export function SourcingCostLedger({ view }: { view: SourcingControlView }) {
  const totals: { id: string; label: string; value: number }[] = [
    { id: "spent", label: "Spent (billing evidence)", value: view.spentMicros },
    { id: "uncertain", label: "Uncertain (possibly charged)", value: view.uncertainMicros },
    { id: "pending", label: "Pending (never dispatched)", value: view.pendingMicros },
  ];
  return (
    <section className="min-w-0 space-y-3" data-testid="sourcing-cost-ledger">
      <h4 className="text-sm font-semibold">
        Cost ledger (read-only, operational planning; not a subscription bill)
      </h4>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {totals.map((t) => (
          <span key={t.id}>
            {t.label}: <b data-testid={`text-cost-${t.id}`}>{usdMicros(t.value)}</b>
          </span>
        ))}
      </div>
      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
        <li>
          Once an operation is dispatching it may already have been charged. Uncertain amounts stay
          counted until billing evidence resolves them.
        </li>
        <li>Pending is the reserved estimates of operations that were never dispatched.</li>
        <li>
          Cancelling a hold releases only unused allocation. Costs can remain counted after the hold
          is cancelled.
        </li>
        <li>
          Zeros do not mean a provider is free; pricing is not audited. Amounts are shown in USD to
          up to six decimals.
        </li>
      </ul>
      {view.costOperations.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-cost-operations">
          No cost operations recorded.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="list-cost-operations">
          {view.costOperations.map((o) => (
            <li
              key={o.id}
              className="min-w-0 rounded-lg border border-border p-3 space-y-1 text-xs"
              data-testid={`cost-operation-${o.id}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b className="text-sm">{o.provider}</b>
                <Badge variant="outline" data-testid={`status-cost-operation-${o.id}`}>
                  {o.status.replace(/_/g, " ")}
                </Badge>
                <span className="text-muted-foreground">
                  pricing version {o.pricingVersion}, recorded{" "}
                  {new Date(o.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                <span>Upper estimate: {usdMicros(o.upperMicros)}</span>
                <span>
                  Actual: {o.actualMicros === null ? "not known" : usdMicros(o.actualMicros)}
                </span>
                <span>
                  Reported:{" "}
                  {o.reportedMicros === null ? "not reported" : usdMicros(o.reportedMicros)}
                </span>
              </div>
              <div className="break-all text-muted-foreground">
                Operation {o.id} on hold {o.reservationId}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
