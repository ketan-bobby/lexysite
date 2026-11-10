import type { SourcingControlView } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { usdMicros } from "./SourcingCostLedger";

export function SourcingProviderCosts({
  analysis,
}: {
  analysis: SourcingControlView["costAnalysis"];
}) {
  return (
    <section className="min-w-0 space-y-3" data-testid="sourcing-provider-costs">
      <h4 className="text-sm font-semibold">Provider billing rules (planning only)</h4>
      <p className="text-xs text-muted-foreground" data-testid="text-cost-warning">
        {analysis.warning} Research dated {analysis.researchDate}. No whole-run total is shown until
        model usage, retries and embedding work are measured.
      </p>
      <p className="text-sm" data-testid="text-known-allowance">
        Partial provider allowance (known rows only, not a run price or upper bound):{" "}
        <b>{usdMicros(analysis.knownAllowanceMicros)}</b>
      </p>
      {analysis.missingProviders.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="text-missing-rates">
          Selected without a usable rate: {analysis.missingProviders.join(", ")}.
        </p>
      )}
      {analysis.exceedsRunCap && (
        <p role="alert" className="text-xs text-destructive" data-testid="text-exceeds-cap">
          Entered planning rates exceed this allocation. This is informational during internal
          testing, not a provider-price prerequisite or a search blocker.
        </p>
      )}
      <ul className="space-y-2">
        {analysis.rows.map((r) => (
          <li
            key={r.id}
            className="min-w-0 rounded-lg border border-border p-2 sm:p-3 space-y-1 text-xs"
            data-testid={`provider-cost-${r.id}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-sm">{r.label}</b>
              <Badge variant="outline">{r.selected ? "selected" : "not selected"}</Badge>
              <Badge variant="outline" data-testid={`status-rate-${r.id}`}>
                rate {r.rateStatus}
              </Badge>
            </div>
            <p>{r.rule}</p>
            <p className="text-muted-foreground">{r.reference}</p>
            <p>
              Credits: {r.credits === null ? "unknown" : r.credits} | Partial allowance:{" "}
              {r.allowanceMicros === null ? "unknown" : usdMicros(r.allowanceMicros)}
              {r.basis ? ` | Basis: ${r.basis.replace(/_/g, " ")}` : ""}
            </p>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              data-testid={`link-source-${r.id}`}
            >
              Official source
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
