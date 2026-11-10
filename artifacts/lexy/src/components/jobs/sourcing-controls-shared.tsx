import type { SourcingLimits } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";

export type Provider = SourcingLimits["providers"][number];
export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "pdl", label: "People Data Labs" },
  { id: "serp", label: "Search results" },
  { id: "enrichlayer", label: "EnrichLayer" },
];

export const usd = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
export const centsToInput = (c: number) => (c / 100).toFixed(2);
/** Strict 2-decimal USD string to integer cents; null when invalid. */
export function parseUsd(s: string): number | null {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}
export const parseInt1 = (s: string): number | null =>
  /^\d{1,7}$/.test(s.trim()) ? Number(s) : null;

export const RATE_PROVIDERS = ["pdl", "serp", "enrichlayer"] as const;
export type RateProvider = (typeof RATE_PROVIDERS)[number];
export interface RateForm {
  rate: string;
  basis: "" | "prepaid_allocation" | "payg";
  source: string;
  expires: string;
}
export const EMPTY_RATE: RateForm = { rate: "", basis: "", source: "", expires: "" };
/** Exact decimal dollars (up to 6 places, max $100) to integer micro USD; no float math. */
export function parseMicros(s: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return v >= 1 && v <= 100_000_000 ? v : null;
}
export function microsToInput(n: number): string {
  const frac = String(n % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${Math.floor(n / 1_000_000)}.${frac.padEnd(2, "0")}`;
}
function validDay(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
const looksSecret = (s: string) =>
  /@|\b(sk|pk|key|token|secret)[-_:= ]*[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,}/i.test(s);

export interface FormState {
  accountRates: Record<RateProvider, RateForm>;
  allowExternal: boolean;
  providers: Provider[];
  maxCandidates: string;
  maxDurationSeconds: string;
  maxRuns: string;
  runBudget: string;
  totalBudget: string;
}

const emptyRates = (): Record<RateProvider, RateForm> => ({
  pdl: { ...EMPTY_RATE },
  serp: { ...EMPTY_RATE },
  enrichlayer: { ...EMPTY_RATE },
});
export const DEFAULT_FORM: FormState = {
  accountRates: emptyRates(),
  allowExternal: false,
  providers: [],
  maxCandidates: "10",
  maxDurationSeconds: "300",
  maxRuns: "3",
  runBudget: "5.00",
  totalBudget: "15.00",
};

const ratesToForm = (l: SourcingLimits): Record<RateProvider, RateForm> => {
  const out = emptyRates();
  for (const k of RATE_PROVIDERS) {
    const r = l.accountRates?.[k];
    if (!r) continue;
    const t = Date.parse(r.expiresAt);
    out[k] = {
      rate: microsToInput(r.microsPerCredit),
      basis: r.basis,
      source: r.source,
      expires: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "",
    };
  }
  return out;
};
export const toForm = (l: SourcingLimits): FormState => ({
  accountRates: ratesToForm(l),
  allowExternal: l.allowExternal,
  providers: [...l.providers].sort(),
  maxCandidates: String(l.maxCandidates),
  maxDurationSeconds: String(l.maxDurationSeconds),
  maxRuns: String(l.maxRuns),
  runBudget: centsToInput(l.runBudgetCents),
  totalBudget: centsToInput(l.totalBudgetCents),
});

export function validate(
  f: FormState,
  employees: boolean,
): { limits: SourcingLimits | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const mc = parseInt1(f.maxCandidates);
  const md = parseInt1(f.maxDurationSeconds);
  const mr = parseInt1(f.maxRuns);
  const rb = parseUsd(f.runBudget);
  const tb = parseUsd(f.totalBudget);
  if (mc === null || mc < 1 || mc > 25) errors.maxCandidates = "Whole number from 1 to 25.";
  if (md === null || md < 30 || md > 900) errors.maxDurationSeconds = "Whole seconds, 30 to 900.";
  if (mr === null || mr < 1 || mr > 20) errors.maxRuns = "Whole number from 1 to 20.";
  if (rb === null || rb < 1 || rb > 1000000) errors.runBudget = "USD amount, $0.01 to $10,000.00.";
  if (tb === null || tb > 10000000) errors.totalBudget = "USD amount, at most $100,000.00.";
  else if (rb !== null && tb < rb)
    errors.totalBudget = "Total must be at least the per-hold amount.";
  const rates: NonNullable<SourcingLimits["accountRates"]> = {};
  for (const k of RATE_PROVIDERS) {
    const r = f.accountRates[k];
    if (r.rate.trim() === "") continue;
    const micros = parseMicros(r.rate);
    const src = r.source.trim();
    const bad = (key: string, msg: string) => (errors[`${key}.${k}`] = msg);
    if (micros === null) bad("rate", "USD per credit, up to 6 decimals, $0.000001 to $100.");
    if (!r.basis) bad("basis", "Choose how this rate is paid.");
    if (src.length < 3 || src.length > 160) bad("source", "3 to 160 characters.");
    else if (looksSecret(src))
      bad("source", "Use a plan name or billing period, never keys or personal data.");
    if (!validDay(r.expires)) bad("expires", "Pick a valid date.");
    if (
      !errors[`rate.${k}`] &&
      !errors[`basis.${k}`] &&
      !errors[`source.${k}`] &&
      !errors[`expires.${k}`]
    )
      rates[k] = {
        microsPerCredit: micros!,
        basis: r.basis as "payg",
        source: src,
        expiresAt: `${r.expires}T23:59:59.999Z`,
      };
  }
  const allow = !employees && f.allowExternal;
  if (allow && f.providers.length === 0) errors.providers = "Select at least one provider.";
  if (Object.keys(errors).length) return { limits: null, errors };
  return {
    errors,
    limits: {
      ...(Object.keys(rates).length ? { accountRates: rates } : {}),
      allowExternal: allow,
      providers: allow ? [...f.providers].sort() : [],
      maxCandidates: mc!,
      maxDurationSeconds: md!,
      maxRuns: mr!,
      runBudgetCents: rb!,
      totalBudgetCents: tb!,
    },
  };
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-[11px] text-destructive" data-testid={`error-${id}`}>
          {error}
        </p>
      )}
    </div>
  );
}
