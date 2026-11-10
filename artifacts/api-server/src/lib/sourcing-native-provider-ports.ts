import { z } from "zod";
import type { CostRequest } from "./sourcing-meter";
import { WorkflowConflict } from "./recruiting-workflows";
import { meteredFetch } from "./vendor-usage";

export const NativePdlRequest = z
  .object({
    title: z.string().min(1).max(400),
    location: z.string().max(400).nullable(),
    size: z.number().int().min(1).max(10),
  })
  .strict();

export function nativeProfileUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(
      value.startsWith("linkedin.com/") || value.startsWith("www.linkedin.com/")
        ? `https://${value}`
        : value,
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["linkedin.com", "www.linkedin.com"].includes(url.hostname) ||
      !/^\/in\/[a-zA-Z0-9%_-]+\/?$/.test(url.pathname)
    )
      return null;
    return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

export const NativeEnrichRequest = z
  .object({
    url: z
      .string()
      .refine((value) => nativeProfileUrl(value) === value, "Canonical profile URL required"),
  })
  .strict();

export function nativeEnrichmentEndpoint(url: string): URL {
  NativeEnrichRequest.parse({ url });
  const endpoint = new URL("https://enrichlayer.com/api/v2/profile");
  endpoint.searchParams.set("profile_url", url);
  return endpoint;
}

/** Read one bounded response; never follow redirects, paginate, widen or retry. */
export async function readNativeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowConflict("Provider returned no response body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000)
        throw new WorkflowConflict("Provider response exceeds the bounded size.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function parseNativePdlResults(body: unknown, limit: number) {
  const parsed = z
    .object({
      data: z
        .array(
          z.object({
            full_name: z.string().nullable().optional(),
            job_title: z.string().nullable().optional(),
            job_company_name: z.string().nullable().optional(),
            location_name: z.string().nullable().optional(),
            linkedin_url: z.string().nullable().optional(),
          }),
        )
        .max(1000),
    })
    .parse(body);
  const seen = new Set<string>();
  const profiles: { title: string; url: string; snippet: string }[] = [];
  for (const person of parsed.data) {
    const url = nativeProfileUrl(person.linkedin_url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    profiles.push({
      title: (person.full_name || person.job_title || "Public profile").slice(0, 160),
      url,
      snippet: [person.job_title, person.job_company_name, person.location_name]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 500),
    });
    if (profiles.length >= limit) break;
  }
  return { profiles };
}

export function parseNativeEnrichResult(body: unknown, url: string) {
  const person = z
    .object({
      full_name: z.string().nullable().optional(),
      headline: z.string().nullable().optional(),
      occupation: z.string().nullable().optional(),
      country_full_name: z.string().nullable().optional(),
    })
    .refine(
      (value) => !!(value.full_name || value.headline || value.occupation),
      "Provider did not return a usable profile",
    )
    .parse(body);
  return {
    profiles: [
      {
        title: (person.full_name || person.occupation || "Public profile").slice(0, 160),
        url,
        snippet: [person.headline || person.occupation, person.country_full_name]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500),
      },
    ],
  };
}

function validatePdl(input: CostRequest) {
  if (input.provider !== "pdl" || input.candidateId)
    throw new WorkflowConflict("Invalid PDL discovery request.");
  NativePdlRequest.parse(input.request);
}
function validateEnrich(input: CostRequest) {
  if (input.provider !== "enrichlayer" || input.candidateId)
    throw new WorkflowConflict("Invalid profile enrichment request.");
  NativeEnrichRequest.parse(input.request);
}

export const NATIVE_ADDITIONAL_PORTS = {
  pdl: {
    id: "pdl" as const,
    version: "pdl:single-search:v1",
    isConfigured: () => !!process.env.PDL_API_KEY,
    validate: validatePdl,
    bound: () => undefined,
    async invoke(input: CostRequest, signal: AbortSignal) {
      const request = NativePdlRequest.parse(input.request);
      const key = process.env.PDL_API_KEY;
      if (!key) throw new WorkflowConflict("PDL is not configured.");
      const must: unknown[] = [{ match_phrase: { job_title: request.title.toLowerCase() } }];
      if (request.location)
        must.push({ match_phrase: { location_name: request.location.toLowerCase() } });
      signal.throwIfAborted();
      const response = await meteredFetch("pdl", undefined, undefined, {
        operationKey: input.operationKey,
      })("https://api.peopledatalabs.com/v5/person/search", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json", "X-Api-Key": key },
        body: JSON.stringify({ query: { bool: { must } }, size: request.size }),
      });
      const json = await readNativeJson(response, signal);
      // Only an explicit provider no-results response is an honest empty success.
      if (
        response.status === 404 &&
        z
          .object({ status: z.literal(404), error: z.object({ type: z.literal("no_results") }) })
          .safeParse(json).success
      )
        return { profiles: [] };
      if (!response.ok) throw new WorkflowConflict("PDL outcome is uncertain; do not retry.");
      return parseNativePdlResults(json, request.size);
    },
  },
  enrichlayer: {
    id: "enrichlayer" as const,
    version: "enrichlayer:single-profile:v1",
    isConfigured: () => !!process.env.ENRICH_LAYER_API_KEY,
    validate: validateEnrich,
    bound: () => undefined,
    async invoke(input: CostRequest, signal: AbortSignal) {
      const request = NativeEnrichRequest.parse(input.request);
      const key = process.env.ENRICH_LAYER_API_KEY;
      if (!key) throw new WorkflowConflict("EnrichLayer is not configured.");
      signal.throwIfAborted();
      const endpoint = nativeEnrichmentEndpoint(request.url);
      const response = await meteredFetch("enrichlayer", undefined, undefined, {
        operationKey: input.operationKey,
      })(endpoint, {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!response.ok)
        throw new WorkflowConflict("Enrichment outcome is uncertain; do not retry.");
      return parseNativeEnrichResult(await readNativeJson(response, signal), request.url);
    },
  },
};
