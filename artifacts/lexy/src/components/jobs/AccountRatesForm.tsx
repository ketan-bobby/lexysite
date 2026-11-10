import { Input } from "@/components/ui/input";
import {
  Field,
  RATE_PROVIDERS,
  PROVIDERS,
  EMPTY_RATE,
  type FormState,
  type RateForm,
  type RateProvider,
} from "./sourcing-controls-shared";

export interface AccountRatesFormProps {
  form: FormState;
  errors: Record<string, string>;
  disabled: boolean;
  set: (patch: Partial<FormState>) => void;
}

export function AccountRatesForm({ form, errors, disabled, set }: AccountRatesFormProps) {
  const patch = (k: RateProvider, p: Partial<RateForm>) =>
    set({ accountRates: { ...form.accountRates, [k]: { ...form.accountRates[k], ...p } } });
  return (
    <section className="min-w-0 space-y-3" data-testid="account-rates-form">
      <h4 className="text-sm font-semibold">Account planning rates (this job)</h4>
      <p className="text-xs text-muted-foreground" data-testid="text-account-rates-disclaimer">
        These are account-entered planning rates, not verified dispatch pricing. They are saved with
        the limits above, and saving revokes any earlier approval. Leave the rate empty to keep it
        unknown; clearing it removes the saved entry. Saved rates are kept even when a provider is
        unchecked. Enter a plan name or billing period as the source, never keys or personal data.
      </p>
      <div className="space-y-3">
        {RATE_PROVIDERS.map((k) => {
          const r = form.accountRates[k] ?? EMPTY_RATE;
          const label = PROVIDERS.find((p) => p.id === k)?.label ?? k;
          return (
            <div
              key={k}
              className="min-w-0 rounded-lg border border-border p-2 sm:p-3 space-y-2"
              data-testid={`account-rate-${k}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-sm">{label}</b>
                {r.rate.trim() !== "" && (
                  <button
                    type="button"
                    className="text-xs underline disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => patch(k, { ...EMPTY_RATE })}
                    data-testid={`button-clear-rate-${k}`}
                  >
                    Clear rate
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field
                  id={`rate-${k}`}
                  label="USD per credit"
                  hint="Up to 6 decimals, max $100."
                  error={errors[`rate.${k}`]}
                >
                  <Input
                    id={`rate-${k}`}
                    inputMode="decimal"
                    placeholder="unknown"
                    value={r.rate}
                    disabled={disabled}
                    onChange={(e) => patch(k, { rate: e.target.value })}
                    data-testid={`input-rate-${k}`}
                  />
                </Field>
                <Field id={`basis-${k}`} label="Basis" error={errors[`basis.${k}`]}>
                  <select
                    id={`basis-${k}`}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    value={r.basis}
                    disabled={disabled}
                    onChange={(e) => patch(k, { basis: e.target.value as RateForm["basis"] })}
                    data-testid={`select-basis-${k}`}
                  >
                    <option value="">Select basis</option>
                    <option value="prepaid_allocation">Prepaid allocation</option>
                    <option value="payg">Pay as you go</option>
                  </select>
                </Field>
                <Field
                  id={`source-${k}`}
                  label="Source"
                  hint="Plan name or billing period."
                  error={errors[`source.${k}`]}
                >
                  <Input
                    id={`source-${k}`}
                    maxLength={160}
                    value={r.source}
                    disabled={disabled}
                    onChange={(e) => patch(k, { source: e.target.value })}
                    data-testid={`input-source-${k}`}
                  />
                </Field>
                <Field
                  id={`expires-${k}`}
                  label="Valid through (UTC)"
                  hint="Through the end of this day."
                  error={errors[`expires.${k}`]}
                >
                  <Input
                    id={`expires-${k}`}
                    type="date"
                    value={r.expires}
                    disabled={disabled}
                    onChange={(e) => patch(k, { expires: e.target.value })}
                    data-testid={`input-expires-${k}`}
                  />
                </Field>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
