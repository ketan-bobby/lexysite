import type { SourcingLimits } from "@workspace/db";

// Research references, not verified account tariffs or executable adapter bounds.
export const COST_RESEARCH_DATE = "2026-10-05";
export function analyzeSourcingCosts(limits: SourcingLimits | null, now = new Date()) {
  const count = limits?.maxCandidates ?? 0;
  const selected = (id: "github" | "pdl" | "serp" | "enrichlayer") =>
    !!limits?.allowExternal && limits.providers.includes(id);
  const row = (
    id: string,
    label: string,
    selected: boolean,
    credits: number | null,
    rule: string,
    reference: string,
    url: string,
  ) => {
    const rate = limits?.accountRates?.[id as "pdl" | "serp" | "enrichlayer"];
    const valid =
      !!rate &&
      Number.isSafeInteger(rate.microsPerCredit) &&
      rate.microsPerCredit > 0 &&
      rate.microsPerCredit <= 100_000_000 &&
      Number.isFinite(Date.parse(rate.expiresAt)) &&
      Date.parse(rate.expiresAt) > now.getTime();
    return {
      id,
      label,
      selected,
      credits,
      rule,
      reference,
      url,
      rateStatus: rate
        ? valid
          ? ("configured" as const)
          : ("expired" as const)
        : ("missing" as const),
      allowanceMicros:
        selected && credits !== null && valid ? credits * rate.microsPerCredit : null,
      basis: rate?.basis ?? null,
    };
  };
  const rows = [
    row(
      "github",
      "GitHub public REST",
      selected("github"),
      0,
      "One user search plus up to 8 profile reads. Public REST reads have no per-request vendor fee, but rate limits apply. AI scoring and infrastructure are not free.",
      "60 unauthenticated requests/hour; generally 5,000 authenticated/hour; search has separate limits.",
      "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    ),
    row(
      "pdl",
      "People Data Labs",
      selected("pdl"),
      4 * count,
      "1 credit per returned person, not per search. Up to 4 location tiers × requested batch size. Every tier's returned rows count, even if discarded or duplicated. This assumes batch size equals the planned target; the legacy runner is not yet bound to it.",
      "USD per credit depends on your package or contract; no default tariff.",
      "https://docs.peopledatalabs.com/docs/reference-person-search-api",
    ),
    row(
      "serp",
      "SerpAPI",
      selected("serp"),
      2,
      "Up to 2 Google searches: strict plus broad fallback. Successful empty searches can charge; provider errors/cached searches are documented as non-chargeable. A timeout does not prove no charge.",
      "Published monthly examples: $25/1,000 ($0.025/search), $75/5,000 ($0.015), $150/15,000 ($0.010), $275/30,000 (~$0.009167). These allocate subscription cost, not new invoice charges.",
      "https://serpapi.com/pricing",
    ),
    row(
      "enrichlayer",
      "Enrich Layer",
      selected("enrichlayer"),
      // Current two-phase registry takes at most N final rows each from PDL and SERP.
      2 * count * (Number(selected("pdl")) + Number(selected("serp"))),
      "Current v2 profile request omits use_cache: default if-recent = 1 base + 1 freshness credit. It stops after 6 successful profiles but can try every distinct upstream URL. Allow 2 credits for each possible seed, not just 6 successes. Endpoint parameter/url compatibility still needs validation.",
      "Published PAYG examples: $10/100 credits ($0.10), $50/834 (~$0.06), $100/3,788 (~$0.0264). Annual packages differ. Native person-search pricing does not apply to this adapter.",
      "https://enrichlayer.com/docs/api/v2/people-api/person-profile",
    ),
    row(
      "model",
      "AI scoring and geography",
      true,
      null,
      "generateJSON uses gpt-4o, up to 4,096 output tokens per call; geography can add a call. Input size, SDK retries, ICP generation and downstream matching add costs. Current helper discards usage metadata, so a whole-run cost is unknown.",
      "Standard GPT-4o: $2.50 input / $10 output per 1M tokens; cached input $1.25. GPT-4o-mini: $0.15 / $0.60, but the scorer does not use mini. Public references, not a measured run.",
      "https://developers.openai.com/api/docs/pricing",
    ),
    row(
      "embedding",
      "Profile embeddings",
      true,
      null,
      "text-embedding-3-small prefers direct OpenAI; without that key the existing helper falls back to the proxy, whose embedding support needs validation. Candidate intelligence can trigger embedding work; count actual input tokens and every retry separately.",
      "Token-billed; separate from scoring. Model/account usage and any additional matching calls still need reconciliation.",
      "https://developers.openai.com/api/docs/pricing",
    ),
  ];
  rows[0].rateStatus = "configured";
  rows[0].allowanceMicros = selected("github") ? 0 : null;
  const knownAllowanceMicros = rows.reduce((n, r) => n + (r.allowanceMicros ?? 0), 0);
  const missingProviders = rows
    .filter((r) => r.selected && r.allowanceMicros === null)
    .map((r) => r.id);
  return {
    researchDate: COST_RESEARCH_DATE,
    planningOnly: true as const,
    rows,
    knownAllowanceMicros,
    missingProviders,
    complete: false as const,
    exceedsRunCap: !!limits && knownAllowanceMicros > limits.runBudgetCents * 10_000,
    warning:
      "Partial provider consumption allowance, NOT a complete-run quote or invoice. Account-entered rates do not verify adapters, quota balances, retries or real billing. No paid execution is enabled.",
  };
}
