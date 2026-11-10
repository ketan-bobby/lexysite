/**
 * Native, single-request discovery ports. Never wrap the existing provider
 * orchestration here: it can fan out, enrich and call models.
 */
import { z } from "zod";
import { livePricingCatalog, type CostRequest, type TrustedCostBound } from "./sourcing-meter";
import { WorkflowConflict } from "./recruiting-workflows";
import { NATIVE_ADDITIONAL_PORTS } from "./sourcing-native-provider-ports";
import { meteredFetch } from "./vendor-usage";
import { isProviderEnabled } from "./sourcing-providers";

export const SERP_DISCOVERY_VERSION = "serp:single-search:v1";
export const NativeSerpRequest = z
  .object({
    q: z.string().min(1).max(1000),
    num: z.number().int().min(1).max(10),
  })
  .strict();
export type NativeProfileRef = { title: string; url: string; snippet: string };
export type NativeDiscoveryResult = { profiles: NativeProfileRef[] };

export function nativeSerpBound(): TrustedCostBound | undefined {
  const quote = livePricingCatalog.get(SERP_DISCOVERY_VERSION);
  if (!quote || quote.pricingVersion !== SERP_DISCOVERY_VERSION) return undefined;
  return { ...quote, expiresAt: new Date(quote.expiresAt) };
}

export function parseNativeSerpResults(json: unknown, limit: number): NativeDiscoveryResult {
  const response = z
    .object({
      error: z.unknown().optional(),
      search_metadata: z.object({ status: z.string() }),
      organic_results: z
        .array(z.object({ title: z.string(), link: z.string(), snippet: z.string().optional() }))
        .max(100)
        .optional(),
    })
    .parse(json);
  if (response.error !== undefined || response.search_metadata.status !== "Success")
    throw new WorkflowConflict("Provider did not confirm a successful search; do not retry.");
  const profiles: NativeProfileRef[] = [];
  const seen = new Set<string>();
  for (const row of response.organic_results ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(row.link);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !["linkedin.com", "www.linkedin.com"].includes(parsed.hostname) ||
      !/^\/in\/[a-zA-Z0-9%_-]+\/?$/.test(parsed.pathname)
    )
      continue;
    const url = `https://www.linkedin.com${parsed.pathname.replace(/\/$/, "")}`;
    if (seen.has(url)) continue;
    seen.add(url);
    profiles.push({
      title: row.title.slice(0, 160),
      url,
      snippet: (row.snippet ?? "").slice(0, 300),
    });
    if (profiles.length >= limit) break;
  }
  return { profiles };
}

async function invokeSerp(input: CostRequest, signal: AbortSignal): Promise<NativeDiscoveryResult> {
  const request = NativeSerpRequest.parse(input.request);
  const key = process.env.SERP_API_KEY || process.env.SERPAPI_KEY;
  if (!key) throw new WorkflowConflict("SerpAPI is not configured.");
  signal.throwIfAborted();
  const url = new URL("https://serpapi.com/search.json");
  url.search = new URLSearchParams({
    engine: "google",
    q: request.q,
    num: String(request.num),
    api_key: key,
  }).toString();
  // A redirect or retry would be another potentially charged request.
  const response = await meteredFetch("serpapi", undefined, undefined, {
    operationKey: input.operationKey,
  })(url, { signal, redirect: "error" });
  if (!response.ok) throw new WorkflowConflict("Search outcome/cost is uncertain; do not retry.");
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowConflict("Search returned no response body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000) throw new WorkflowConflict("Search response exceeds the bounded size.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return parseNativeSerpResults(JSON.parse(Buffer.concat(chunks).toString("utf8")), request.num);
}

export const NATIVE_SOURCING_ADAPTERS = {
  serp: {
    id: "serp" as const,
    version: SERP_DISCOVERY_VERSION,
    isConfigured: () => !!(process.env.SERP_API_KEY || process.env.SERPAPI_KEY),
    isEnabled: () => isProviderEnabled("serp"),
    validate: (input: CostRequest) => {
      if (input.provider !== "serp" || input.candidateId)
        throw new WorkflowConflict("This port supports discovery only, not enrichment or models.");
      NativeSerpRequest.parse(input.request);
    },
    bound: nativeSerpBound,
    invoke: invokeSerp,
  },
  pdl: { ...NATIVE_ADDITIONAL_PORTS.pdl, isEnabled: () => isProviderEnabled("pdl") },
  enrichlayer: {
    ...NATIVE_ADDITIONAL_PORTS.enrichlayer,
    isEnabled: () => isProviderEnabled("enrichlayer"),
  },
};
