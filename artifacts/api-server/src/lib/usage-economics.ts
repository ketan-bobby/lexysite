import { z } from "zod";
import type { VendorUsageUnits } from "@workspace/db";
import { observeRequestCost } from "./vendor-cost-observation";

const instant = z.string().datetime({ offset: true });
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unit = z.enum([
  "uncached_input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "input_tokens",
  "billed_audio_seconds",
  "billed_video_seconds",
  "billed_characters",
  "provider_reported_credits",
  "input_audio_tokens",
  "input_text_tokens",
  "output_audio_tokens",
  "output_text_tokens",
]);

/** Local operations input only; references are opaque invoice/account references,
 * not documents, URLs, credentials, candidate identifiers or free text. */
export const economicsEvidenceSchema = z
  .object({
    tariffs: z
      .array(
        z
          .object({
            id,
            provider: id,
            accountRef: id,
            model: id.nullable(),
            operation: id,
            unit,
            currency: z.string().regex(/^[A-Z]{3}$/),
            amountMicros: integer,
            perUnits: integer.positive(),
            from: instant,
            to: instant,
            evidenceRef: id,
            verifiedOn: instant,
          })
          .strict(),
      )
      .default([]),
    allocations: z
      .array(
        z
          .object({
            id,
            sourceRef: id,
            evidenceRef: id.nullable(),
            category: z.enum(["vendor_commitment", "infrastructure", "direct_support"]),
            currency: z.string().regex(/^[A-Z]{3}$/),
            totalMicros: integer.nullable(),
            basis: z.enum([
              "measured_requests",
              "measured_seconds",
              "storage_byte_days",
              "support_minutes",
              "contract_share",
            ]),
            from: instant,
            to: instant,
            // Include every recipient, including unallocated overhead. Never
            // renormalize foreign/omitted shares onto the visible tenant.
            shares: z
              .array(z.object({ tenantId: id.nullable(), basisUnits: integer }).strict())
              .min(1),
            // Explicitly prevent adding a commitment already represented by tariffs.
            treatment: z.enum(["incremental", "already_in_tariff", "hypothetical"]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const entry of [...value.tariffs, ...value.allocations]) {
      if (seen.has(entry.id))
        ctx.addIssue({ code: "custom", message: "Duplicate evidence identity" });
      seen.add(entry.id);
      if (Date.parse(entry.from) >= Date.parse(entry.to))
        ctx.addIssue({ code: "custom", message: "Evidence interval must be nonempty" });
    }
    const sources = new Set<string>();
    for (const allocation of value.allocations) {
      if (sources.has(allocation.sourceRef))
        ctx.addIssue({ code: "custom", message: "An invoice source can be allocated only once" });
      sources.add(allocation.sourceRef);
      const recipients = allocation.shares.map((share) => share.tenantId);
      if (
        new Set(recipients).size !== recipients.length ||
        !allocation.shares.some((share) => share.basisUnits > 0)
      )
        ctx.addIssue({
          code: "custom",
          message: "Allocation needs unique recipients and a positive denominator",
        });
      if (
        allocation.treatment === "incremental" &&
        (allocation.totalMicros === null || allocation.evidenceRef === null)
      )
        ctx.addIssue({
          code: "custom",
          message: "Observed allocation requires invoice evidence and an amount",
        });
    }
  });
export type EconomicsEvidence = z.infer<typeof economicsEvidenceSchema>;
export type EconomicsAttempt = {
  id: string;
  createdAt: Date;
  tenantId: string | null;
  area: string;
  provider: string;
  operation: string;
  model: string | null;
  retryIndex: number | null;
  status: string;
  units: VendorUsageUnits;
};
export type EconomicsTenant = { id: string; parentId: string | null };
type Fraction = { numeratorMicros: string; denominator: string };
const fraction = (numerator: bigint, denominator = 1n): Fraction => {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const factor = gcd(numerator, denominator);
  return { numeratorMicros: String(numerator / factor), denominator: String(denominator / factor) };
};
const add = (a: Fraction, b: Fraction): Fraction =>
  fraction(
    BigInt(a.numeratorMicros) * BigInt(b.denominator) +
      BigInt(b.numeratorMicros) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
const quantity = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
const quantityFraction = (value: number): [bigint, bigint] | null => {
  // Receipt decimals up to micro-units; reject unsupported precision rather
  // than silently rounding provider units or fabricating exactness.
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, decimal = ""] = text.split(".");
  return [BigInt(whole + decimal), 10n ** BigInt(decimal.length)];
};

export function billingRoot(
  tenantId: string | null,
  tenants: ReadonlyMap<string, EconomicsTenant>,
): string | null {
  const seen = new Set<string>();
  while (tenantId !== null) {
    if (seen.has(tenantId) || seen.size >= 30) return null;
    seen.add(tenantId);
    const tenant = tenants.get(tenantId);
    if (!tenant) return null;
    if (tenant.parentId === null) return tenant.id;
    tenantId = tenant.parentId;
  }
  return null;
}

function billableUnits(attempt: EconomicsAttempt): Record<string, number | null> {
  const u = attempt.units;
  if (attempt.status !== "succeeded") return {};
  if (attempt.operation === "chat") {
    const input = quantity(u.input_tokens),
      cached = quantity(u.cached_input_tokens);
    return {
      uncached_input_tokens:
        input !== null && cached !== null && cached <= input ? input - cached : null,
      cached_input_tokens: input !== null && cached !== null && cached <= input ? cached : null,
      output_tokens: quantity(u.output_tokens),
    };
  }
  if (attempt.operation === "embedding") return { input_tokens: quantity(u.input_tokens) };
  if (
    ["stt", "tts"].includes(attempt.operation) &&
    [u.input_audio_tokens, u.input_text_tokens, u.output_audio_tokens, u.output_text_tokens].some(
      (v) => quantity(v) !== null,
    )
  )
    return {
      input_audio_tokens: quantity(u.input_audio_tokens),
      input_text_tokens: quantity(u.input_text_tokens),
      ...(quantity(u.output_audio_tokens) !== null || quantity(u.output_text_tokens) !== null
        ? {
            output_audio_tokens: quantity(u.output_audio_tokens),
            output_text_tokens: quantity(u.output_text_tokens),
          }
        : { output_tokens: quantity(u.output_tokens) }),
    };
  if (["stt", "tts"].includes(attempt.operation))
    return {
      billed_audio_seconds: quantity(u.billed_audio_seconds),
      billed_characters: quantity(u.billed_characters),
      provider_reported_credits: quantity(u.provider_reported_credits),
    };
  if (attempt.operation === "video_generate")
    return {
      billed_video_seconds: quantity(u.billed_video_seconds),
      provider_reported_credits: quantity(u.provider_reported_credits),
    };
  if (["search", "enrichment"].includes(attempt.operation))
    return { provider_reported_credits: quantity(u.provider_reported_credits) };
  return {};
}

/** Operations-only pure aggregation. Filter leaf scope BEFORE rolling up to
 * roots: authorization to one child does not authorize siblings. No row IDs,
 * candidate IDs, workflow IDs, prompts, answers or receipt IDs in output. */
export function aggregateEconomics(
  attempts: EconomicsAttempt[],
  tenants: EconomicsTenant[],
  options: {
    from: Date;
    to: Date;
    allowedTenantIds: ReadonlySet<string> | null;
    evidence?: EconomicsEvidence;
  },
) {
  if (
    !Number.isFinite(+options.from) ||
    !Number.isFinite(+options.to) ||
    +options.from >= +options.to
  )
    throw new Error("Invalid half-open reporting period");
  const evidence = economicsEvidenceSchema.parse(options.evidence ?? {});
  const tree = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const visible = (tenant: string | null) =>
    options.allowedTenantIds === null || (tenant !== null && options.allowedTenantIds.has(tenant));
  const groups = new Map<
    string,
    {
      tenantId: string | null;
      billingRoot: string | null;
      country: string | null;
      plan: string | null;
      area: string;
      provider: string;
      operation: string;
      model: string | null;
      attempts: number;
      retries: number;
      unknownRetryIndex: number;
      failedOrAmbiguous: number;
      duplicateReceipts: number;
      unknownAmountAttempts: number;
      observedUnits: Record<string, number>;
      observedBillableUnits: Record<string, number>;
      accountVerifiedTariffCalculation: Record<string, Fraction>;
      hypotheticalPublicRateUsd: number | null;
    }
  >();
  const seenAttempts = new Set<string>(),
    seenReceipts = new Set<string>(),
    usedTariffs = new Set<string>();
  const latest = new Map<string, EconomicsAttempt>();
  for (const attempt of attempts) if (visible(attempt.tenantId)) latest.set(attempt.id, attempt);
  for (const a of latest.values()) {
    if (
      !visible(a.tenantId) ||
      +a.createdAt < +options.from ||
      +a.createdAt >= +options.to ||
      seenAttempts.has(a.id)
    )
      continue;
    seenAttempts.add(a.id);
    const root =
      typeof a.units.billing_root_id === "string"
        ? a.units.billing_root_id
        : billingRoot(a.tenantId, tree);
    const country = typeof a.units.billing_country === "string" ? a.units.billing_country : null;
    const plan = typeof a.units.billing_plan === "string" ? a.units.billing_plan : null;
    const model = typeof a.units.returned_model === "string" ? a.units.returned_model : a.model;
    const area = a.area.startsWith("workflow:") ? `workflow:${a.area.split(":").at(-1)}` : a.area;
    const dimensions = {
      tenantId: a.tenantId,
      billingRoot: root,
      country,
      plan,
      area,
      provider: a.provider,
      operation: a.operation,
      model,
    };
    const key = JSON.stringify(dimensions);
    let group = groups.get(key);
    if (!group) {
      group = {
        ...dimensions,
        attempts: 0,
        retries: 0,
        unknownRetryIndex: 0,
        failedOrAmbiguous: 0,
        duplicateReceipts: 0,
        unknownAmountAttempts: 0,
        observedUnits: {},
        observedBillableUnits: {},
        accountVerifiedTariffCalculation: {},
        hypotheticalPublicRateUsd: null,
      };
      groups.set(key, group);
    }
    group.attempts++;
    if (a.retryIndex === null) group.unknownRetryIndex++;
    else if (a.retryIndex > 0) group.retries++;
    if (a.status !== "succeeded") group.failedOrAmbiguous++;
    const receipt = a.units.provider_request_id;
    const account = a.units.account_ref;
    // No timestamp correlation or candidate/profile identity inference.
    const receiptKey =
      typeof receipt === "string"
        ? JSON.stringify([a.provider, account ?? null, a.operation, receipt])
        : null;
    if (receiptKey && seenReceipts.has(receiptKey)) {
      group.duplicateReceipts++;
      group.unknownAmountAttempts++;
      continue;
    }
    if (receiptKey) seenReceipts.add(receiptKey);
    for (const name of [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "input_audio_tokens",
      "input_text_tokens",
      "output_audio_tokens",
      "output_text_tokens",
      "audio_seconds",
      "input_characters",
      "audio_bytes",
      "observed_api_requests",
    ]) {
      const value = quantity(a.units[name]);
      if (value !== null) group.observedUnits[name] = (group.observedUnits[name] ?? 0) + value;
    }
    const billed = billableUnits(a);
    let complete = Object.keys(billed).length > 0 && a.status === "succeeded";
    // Speech can be billed in seconds OR characters OR credits; unknown
    // alternatives are not extra unknown charges.
    const alternative =
      ["stt", "tts", "video_generate"].includes(a.operation) &&
      !Object.keys(billed).some((name) => name.endsWith("_tokens"));
    let entries = Object.entries(billed).filter(([, value]) => !alternative || value !== null);
    let alternativesRecorded = false;
    if (entries.length === 0) complete = false;
    if (alternative && entries.length > 1) {
      // Credits/characters/seconds may describe the same charge. Only a single
      // account-confirmed billing basis may be priced, never all alternatives.
      const priced = entries.filter(([name]) =>
        evidence.tariffs.some(
          (rate) =>
            rate.provider === a.provider &&
            rate.accountRef === account &&
            rate.model === model &&
            rate.operation === a.operation &&
            rate.unit === name &&
            Date.parse(rate.from) <= +a.createdAt &&
            +a.createdAt < Date.parse(rate.to),
        ),
      );
      for (const [name, value] of entries)
        if (value !== null)
          group.observedBillableUnits[name] = (group.observedBillableUnits[name] ?? 0) + value;
      entries = priced.length === 1 ? priced : [];
      if (!entries.length) complete = false;
      // Alternative observations were already counted above.
      alternativesRecorded = true;
    }
    for (const [name, value] of entries) {
      if (value === null) {
        complete = false;
        continue;
      }
      if (!alternativesRecorded)
        group.observedBillableUnits[name] = (group.observedBillableUnits[name] ?? 0) + value;
      const rates = evidence.tariffs.filter(
        (rate) =>
          rate.provider === a.provider &&
          rate.accountRef === account &&
          rate.model === model &&
          rate.operation === a.operation &&
          rate.unit === name &&
          Date.parse(rate.from) <= +a.createdAt &&
          +a.createdAt < Date.parse(rate.to),
      );
      const q = quantityFraction(value);
      if (rates.length !== 1 || q === null) {
        complete = false;
        continue;
      }
      const rate = rates[0];
      usedTariffs.add(rate.id);
      const cost = fraction(q[0] * BigInt(rate.amountMicros), q[1] * BigInt(rate.perUnits));
      group.accountVerifiedTariffCalculation[rate.currency] = add(
        group.accountVerifiedTariffCalculation[rate.currency] ?? fraction(0n),
        cost,
      );
    }
    if (!complete) group.unknownAmountAttempts++;
    const estimate = observeRequestCost(a);
    if (estimate.estimatedCostUsd !== null)
      group.hypotheticalPublicRateUsd =
        (group.hypotheticalPublicRateUsd ?? 0) + estimate.estimatedCostUsd;
  }
  const allocations = evidence.allocations.flatMap((allocation) => {
    // Partial-period invoices need an explicit allocation, not guessed proration.
    if (Date.parse(allocation.from) < +options.from || Date.parse(allocation.to) > +options.to)
      return [];
    const denominator = allocation.shares.reduce(
      (sum, share) => sum + BigInt(share.basisUnits),
      0n,
    );
    return allocation.shares
      .filter((share) => visible(share.tenantId))
      .map((share) => ({
        tenantId: share.tenantId,
        billingRoot: billingRoot(share.tenantId, tree),
        category: allocation.category,
        basis: allocation.basis,
        basisUnits: share.basisUnits,
        currency: allocation.currency,
        treatment: allocation.treatment,
        status:
          allocation.totalMicros === null
            ? "unknown"
            : allocation.treatment === "hypothetical"
              ? "hypothetical"
              : allocation.treatment === "already_in_tariff"
                ? "excluded_double_count"
                : "invoice_allocation",
        amount:
          allocation.totalMicros === null || allocation.treatment === "already_in_tariff"
            ? null
            : fraction(BigInt(allocation.totalMicros) * BigInt(share.basisUnits), denominator),
      }));
  });
  const roots = new Map<
    string,
    {
      billingRoot: string | null;
      country: string | null;
      plan: string | null;
      attempts: number;
      unknownAmountAttempts: number;
      failedOrAmbiguous: number;
      observedBillableUnits: Record<string, number>;
      accountVerifiedTariffCalculation: Record<string, Fraction>;
      hypotheticalPublicRateUsd: number | null;
    }
  >();
  for (const row of groups.values()) {
    const dimensions = { billingRoot: row.billingRoot, country: row.country, plan: row.plan };
    const key = JSON.stringify(dimensions);
    let total = roots.get(key);
    if (!total) {
      total = {
        ...dimensions,
        attempts: 0,
        unknownAmountAttempts: 0,
        failedOrAmbiguous: 0,
        observedBillableUnits: {},
        accountVerifiedTariffCalculation: {},
        hypotheticalPublicRateUsd: null,
      };
      roots.set(key, total);
    }
    total.attempts += row.attempts;
    total.unknownAmountAttempts += row.unknownAmountAttempts;
    total.failedOrAmbiguous += row.failedOrAmbiguous;
    for (const [unitName, amount] of Object.entries(row.observedBillableUnits))
      total.observedBillableUnits[unitName] = (total.observedBillableUnits[unitName] ?? 0) + amount;
    for (const [currency, amount] of Object.entries(row.accountVerifiedTariffCalculation))
      total.accountVerifiedTariffCalculation[currency] = add(
        total.accountVerifiedTariffCalculation[currency] ?? fraction(0n),
        amount,
      );
    if (row.hypotheticalPublicRateUsd !== null)
      total.hypotheticalPublicRateUsd =
        (total.hypotheticalPublicRateUsd ?? 0) + row.hypotheticalPublicRateUsd;
  }
  return {
    period: {
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      boundary: "[from,to)",
    },
    coverage: "Instrumented attempts only; missing receipts/persistence are unknown, not free.",
    privacy: "Internal operations only; developmental usage has no employer/candidate linkage.",
    pricing: "Tariff calculations are not settled invoices. Estimates never establish allowances.",
    verifiedInvoiceCost: null,
    tariffEvidence: evidence.tariffs
      .filter((rate) => usedTariffs.has(rate.id))
      .map(({ id: tariffId, evidenceRef, verifiedOn, ...rate }) => ({
        tariffId,
        evidenceRef,
        verifiedOn,
        ...rate,
      })),
    rows: [...groups.values()],
    billingRootTotals: [...roots.values()],
    allocations,
    exclusions: [
      "credit_usage_events.units are activity, never vendor dollars",
      "stt_transcribe_events are quality outcomes, not additional billed attempts",
      "video status polls do not create another render charge",
      "no historical country/plan inferred for legacy observations",
    ],
  };
}
