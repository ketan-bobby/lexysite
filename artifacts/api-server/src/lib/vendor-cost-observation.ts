import type { VendorUsageUnits } from "@workspace/db";
import { PUBLIC_RATE_REFERENCE } from "./vendor-rate-reference";

type Observation = {
  provider: string;
  operation: string;
  status: string;
  model: string | null;
  units: VendorUsageUnits;
};
const numeric = (value: number | string | null | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Read-only estimate, never an invoice, admission decision or stored charge. */
export function observeRequestCost(attempt: Observation) {
  const unknown = {
    verifiedCostUsd: null,
    estimatedCostUsd: null as number | null,
    costStatus: "unknown" as "unknown" | "public_rate_estimate",
    rateSource: null as string | null,
    rateCheckedOn: null as string | null,
  };
  if (attempt.provider !== "openai_direct" || attempt.status !== "succeeded") return unknown;
  const rate = PUBLIC_RATE_REFERENCE.rates.find((entry) => entry.model === attempt.model);
  if (!rate) return unknown; // Never map Azure deployments, proxy rates or aliases.
  const input = numeric(attempt.units.input_tokens);
  if (input === null) return unknown;
  let estimated: number;
  if (attempt.operation === "embedding" && rate.model === "text-embedding-3-small") {
    estimated = (input * rate.input) / 1_000_000;
  } else if (attempt.operation === "chat" && rate.cachedInput !== null && rate.output !== null) {
    const cached = numeric(attempt.units.cached_input_tokens);
    const output = numeric(attempt.units.output_tokens);
    if (cached === null || output === null || cached > input) return unknown;
    // Cached tokens are included in input; reasoning is included in output.
    estimated =
      ((input - cached) * rate.input + cached * rate.cachedInput + output * rate.output) /
      1_000_000;
  } else {
    return unknown;
  }
  return {
    ...unknown,
    estimatedCostUsd: estimated,
    costStatus: "public_rate_estimate" as const,
    rateSource: rate.source,
    rateCheckedOn: PUBLIC_RATE_REFERENCE.checkedOn,
  };
}
