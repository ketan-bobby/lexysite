import type { SourcingControlView } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

type Pkg = NonNullable<SourcingControlView["monthlyPackages"]>;
const cap = (n: number) => (n < 0 ? "Unlimited plan limit" : n.toLocaleString("en-US"));

export function MonthlySourcingPackages({ packages }: { packages: Pkg | null | undefined }) {
  if (!packages) {
    return (
      <section className="min-w-0 space-y-2" data-testid="monthly-packages-unavailable">
        <h4 className="text-sm font-semibold">Monthly company plans</h4>
        <p className="text-xs text-muted-foreground">
          Monthly plan prices are unavailable right now. No price is assumed.
        </p>
      </section>
    );
  }
  const annual = packages.billingTerm.toLowerCase() !== "monthly";
  return (
    <section className="min-w-0 space-y-3" data-testid="monthly-packages">
      <h4 className="text-sm font-semibold">Monthly company plans</h4>
      <p className="text-xs text-muted-foreground">
        Read-only reference. Nothing here changes your plan, price or fees.{" "}
        {packages.country
          ? `Prices for ${packages.country}.`
          : "No account country is set, so these are US catalog reference prices, not verified account-country prices."}{" "}
        Taxes and fees are unchanged; see each tax note.
        {annual &&
          ` Your billing term is ${packages.billingTerm}; monthly figures are references, not the actual ${packages.billingTerm} charge.`}
      </p>
      <ul className="grid gap-3 sm:grid-cols-3">
        {packages.tiers.map((t) => {
          const current = t.code === packages.currentPlan;
          return (
            <li
              key={t.code}
              className={`min-w-0 rounded-lg border p-3 space-y-2 text-xs ${current ? "border-primary" : "border-border"}`}
              data-testid={`package-${t.code}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-sm">{t.name}</b>
                {current && <Badge data-testid="badge-current-plan">Current plan</Badge>}
              </div>
              <p className="text-base font-semibold" data-testid={`text-package-price-${t.code}`}>
                {t.amount < 0
                  ? "Contact sales"
                  : `${t.symbol}${t.amount.toLocaleString("en-US")} ${t.currency} / month`}
              </p>
              <p className="text-muted-foreground">{t.taxNote}</p>
              <dl className="space-y-0.5">
                <div>Open jobs: {cap(t.maxOpenJobs)}</div>
                <div>Staff seats: {cap(t.maxStaffSeats)}</div>
                <div>Candidate database searches / month: {cap(t.candidateDbSearchesPerMonth)}</div>
                <div>
                  AI generations / month (entitlement, not dollars): {cap(t.aiGenerationsPerMonth)}
                </div>
              </dl>
              <p className="text-muted-foreground">Source: {t.priceSource}</p>
            </li>
          );
        })}
      </ul>
      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
        <li>
          Unlimited describes a plan limit, not unlimited vendor spending. Database searches are not
          external profiles.
        </li>
        {!packages.sourcingAllowanceConfigured && (
          <li data-testid="text-allowance-unconfigured">
            A shared monthly external-sourcing allowance is not yet configured or enforced. No
            monthly vendor quota or remaining usage is shown.
          </li>
        )}
        <li>{packages.note}</li>
      </ul>
    </section>
  );
}
