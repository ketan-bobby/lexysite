/** Verified PUBLIC sources, not account-specific prices, receipts or authority.
 * Standard on-demand text-token rates in USD per million; never guess model
 * aliases, Azure deployments, audio units or avatar engines. */
export const PUBLIC_RATE_REFERENCE = {
  checkedOn: "2026-10-06",
  status: "public_reference_only",
  accountVerified: false,
  currency: "USD",
  unit: "per_million_tokens",
  rates: [
    {
      model: "gpt-4o",
      input: 2.5,
      cachedInput: 1.25,
      output: 10,
      source: "https://developers.openai.com/api/docs/models/gpt-4o",
    },
    {
      model: "gpt-4o-mini",
      input: 0.15,
      cachedInput: 0.075,
      output: 0.6,
      source: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
    },
    {
      model: "text-embedding-3-small",
      input: 0.02,
      cachedInput: null,
      output: null,
      source: "https://developers.openai.com/api/docs/models/text-embedding-3-small",
    },
  ],
  proxyPricingSource: "https://docs.replit.com/features/integrations/replit-ai-integrations",
  limitations: [
    "Public standard rates are not audited account charges or historical tariffs.",
    "Per-request calculations are public-rate estimates only; stored costStatus remains unknown.",
    "Cached tokens are part of input tokens; reasoning tokens are part of output, not additional.",
    "No mapping is inferred for Azure deployments, dated aliases, service tiers or negotiated plans.",
    "Speech, avatars, subscription credits, retries/errors and taxes require separate billing evidence.",
  ],
} as const;
