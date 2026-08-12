/**
 * sourcing-providers.ts — External Sourcing Provider Adapter Layer
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A single, provider-agnostic adapter interface in front of the external
 * candidate-sourcing/enrichment providers (GitHub, People Data Labs, SerpAPI,
 * EnrichLayer). Call sites (routes/sourcing.ts, lib/agents/orchestrator.ts)
 * talk to THIS module instead of importing each `search*` adapter directly, so
 * that:
 *
 *   • A provider can be disabled or swapped via configuration (env) without
 *     touching any call site.
 *   • Provider failures degrade gracefully — a thrown adapter never breaks the
 *     fan-out; it returns a clear `skipped` reason instead.
 *   • Every provider run is observable: timing + result count + skip reason are
 *     logged with a consistent structured shape.
 *
 * The actual query/parse/score logic still lives in external-sourcing.ts — this
 * layer is strictly the abstraction boundary (registry + orchestration +
 * config + observability). It does NOT change scoring or sourcing behaviour.
 *
 * ─── Two phases ──────────────────────────────────────────────────────────────
 *   discovery   — GitHub, PDL, SerpAPI run in parallel and return candidates,
 *                 some carrying a LinkedIn URL.
 *   enrichment  — EnrichLayer runs second, seeded with the LinkedIn URLs found
 *                 by the discovery phase (PDL first — highest signal — then
 *                 SerpAPI), to enrich them into full profiles.
 *
 * ─── Config ──────────────────────────────────────────────────────────────────
 *   SOURCING_DISABLED_PROVIDERS — comma-separated provider ids to disable
 *                                 (e.g. "pdl,enrichlayer"). Unset = all enabled
 *                                 (current behaviour). A disabled provider is
 *                                 skipped at every call site with a clear reason.
 */
import {
  searchGitHub,
  searchPDL,
  searchSerp,
  searchEnrichLayer,
  type SearchContext,
  type AdapterResult,
} from "./external-sourcing.js";
import { logger } from "./logger.js";

export type ProviderId = "github" | "pdl" | "serp" | "enrichlayer";
export type ProviderKind = "discovery" | "enrichment";

/** Provider-agnostic adapter. Every external source implements this. */
export interface SourcingProvider {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** True when the provider can produce results at all (keys present, or the
   *  provider has a keyless fallback). Maps to "available" in the status feed. */
  isConfigured(): boolean;
  /** True when the provider's primary API key is present (status display only). */
  hasApiKey(): boolean;
  /** Run the underlying adapter. Enrichment providers receive discovery seed URLs. */
  run(ctx: SearchContext, seedUrls: string[]): Promise<AdapterResult>;
  /** Human-readable availability note for the status endpoint. */
  note(): string;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  available: boolean; // enabled by config AND configured (can produce results)
  apiKey: boolean; // primary key present
  enabled: boolean; // not disabled by config
  note: string;
}

/** A provider registry — the unit that callers fan out over and that tests/
 *  future swaps can replace. */
export type ProviderRegistry = Record<ProviderId, SourcingProvider>;

const serpConfigured = (): boolean => !!(process.env.SERP_API_KEY || process.env.SERPAPI_KEY);

/* ── Built-in registry: thin wrappers over the existing adapters ─────────── */
export const SOURCING_PROVIDERS: ProviderRegistry = {
  github: {
    id: "github",
    label: "GitHub",
    kind: "discovery",
    // GITHUB_TOKEN is optional — the adapter works unauthenticated (rate-limited).
    isConfigured: () => true,
    hasApiKey: () => !!process.env.GITHUB_TOKEN,
    run: (ctx) => searchGitHub(ctx),
    note: () => "Engineering roles only",
  },
  pdl: {
    id: "pdl",
    label: "People Data Labs",
    kind: "discovery",
    isConfigured: () => !!process.env.PDL_API_KEY,
    hasApiKey: () => !!process.env.PDL_API_KEY,
    run: (ctx) => searchPDL(ctx),
    note: () => (process.env.PDL_API_KEY ? "PDL connected" : "Requires PDL_API_KEY"),
  },
  serp: {
    id: "serp",
    label: "SerpAPI",
    kind: "discovery",
    // Falls back to AI-assisted search when no key is set, so always available.
    isConfigured: () => true,
    hasApiKey: () => serpConfigured(),
    run: (ctx) => searchSerp(ctx),
    note: () => (serpConfigured() ? "SERP API connected" : "Using AI-assisted search"),
  },
  enrichlayer: {
    id: "enrichlayer",
    label: "EnrichLayer",
    kind: "enrichment",
    // Needs its own key AND SerpAPI for the URL-discovery step it seeds from.
    isConfigured: () => !!process.env.ENRICH_LAYER_API_KEY && serpConfigured(),
    hasApiKey: () => !!process.env.ENRICH_LAYER_API_KEY,
    run: (ctx, seedUrls) => searchEnrichLayer(ctx, seedUrls),
    note: () =>
      process.env.ENRICH_LAYER_API_KEY
        ? serpConfigured()
          ? "EnrichLayer enrichment active"
          : "Needs SERP_API_KEY for URL discovery"
        : "Requires ENRICH_LAYER_API_KEY",
  },
};

/* ── Config-driven enable/disable ───────────────────────────────────────── */
function disabledSet(): Set<string> {
  return new Set(
    (process.env.SOURCING_DISABLED_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A provider is enabled unless explicitly listed in SOURCING_DISABLED_PROVIDERS. */
export function isProviderEnabled(id: ProviderId): boolean {
  return !disabledSet().has(id);
}

const empty = (reason: string): AdapterResult => ({ candidates: [], query: "", skipped: reason });

/* ── Per-kind run timeout — a safety net against hung connections ──────────────
 * runProvider only catches adapter errors that THROW. A stalled fetch (e.g. a
 * hung PDL or SerpAPI socket) never throws, so without this it would block the
 * whole discovery Promise.all indefinitely — defeating graceful degradation.
 * We race every p.run() against a timeout and degrade to a clean `skipped`.
 *
 * The ceilings differ by kind on purpose: discovery providers should fail fast,
 * while the enrichment provider walks a seed list SEQUENTIALLY (up to ~6 profiles
 * × ~12s each) and so needs a much longer ceiling to avoid truncating legitimate
 * work. Both are overridable per deployment:
 *   SOURCING_DISCOVERY_TIMEOUT_MS   (default 20000)
 *   SOURCING_ENRICHMENT_TIMEOUT_MS  (default 90000)
 */
const DISCOVERY_TIMEOUT_MS = 20_000;
const ENRICHMENT_TIMEOUT_MS = 90_000;

function providerTimeoutMs(kind: ProviderKind): number {
  const envName =
    kind === "discovery" ? "SOURCING_DISCOVERY_TIMEOUT_MS" : "SOURCING_ENRICHMENT_TIMEOUT_MS";
  const raw = Number(process.env[envName]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return kind === "discovery" ? DISCOVERY_TIMEOUT_MS : ENRICHMENT_TIMEOUT_MS;
}

/* ── Observable, never-throwing provider runner ─────────────────────────── */
async function runProvider(
  p: SourcingProvider,
  ctx: SearchContext,
  seedUrls: string[],
): Promise<AdapterResult> {
  if (!isProviderEnabled(p.id)) {
    logger.info({ provider: p.id, kind: p.kind }, "[sourcing-provider] disabled by configuration");
    return empty(`${p.label} disabled by configuration`);
  }
  const start = Date.now();
  const timeoutMs = providerTimeoutMs(p.kind);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<AdapterResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(empty(`${p.label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const runPromise = p.run(ctx, seedUrls);
    // If the timeout wins the race, the run promise may still settle (reject)
    // later — attach a no-op catch so a late rejection never surfaces as an
    // unhandled rejection. The race below still sees a real rejection if the
    // run loses to nothing (i.e. rejects before the timeout fires).
    runPromise.catch(() => undefined);
    const result = await Promise.race([runPromise, timeoutPromise]);
    if (timedOut) {
      // Graceful degradation: a hung adapter must never block the fan-out.
      logger.warn(
        { provider: p.id, kind: p.kind, durationMs: Date.now() - start, timeoutMs },
        "[sourcing-provider] timed out — degrading gracefully",
      );
    } else {
      logger.info(
        {
          provider: p.id,
          kind: p.kind,
          durationMs: Date.now() - start,
          count: result.candidates.length,
          skipped: result.skipped ?? null,
        },
        "[sourcing-provider] completed",
      );
    }
    return result;
  } catch (err: any) {
    // Graceful degradation: a thrown adapter must never break the fan-out.
    logger.warn(
      { provider: p.id, kind: p.kind, durationMs: Date.now() - start, err: err?.message },
      "[sourcing-provider] threw — degrading gracefully",
    );
    return empty(`${p.label} error: ${err?.message ?? "unknown error"}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RunSourcingOptions {
  /** Restrict to these provider ids (e.g. recruiter-toggled sources). Unknown
   *  ids are ignored; omitted = run every provider in the registry. */
  requested?: string[];
  /** Inject a different registry (testing / provider swaps). Defaults to the
   *  built-in SOURCING_PROVIDERS. */
  registry?: ProviderRegistry;
  /** When FALSE, providers that would otherwise fabricate results without a
   *  key (SERP's LLM-simulated profiles) return skipped/empty instead. REAL
   *  agent runs that persist candidates MUST pass false. Default true keeps
   *  the interactive preview behavior. */
  allowSimulatedFallback?: boolean;
  /** Optional live-progress observer. Called as each provider starts/finishes
   *  so long fan-outs (a real agent run takes minutes) can surface per-provider
   *  progress. MUST be non-throwing from the caller's perspective — invoked
   *  fire-and-forget and never awaited, so it cannot slow or break the fan-out. */
  onProviderEvent?: (e: {
    provider: ProviderId;
    label: string;
    phase: "started" | "completed";
    count?: number;
    skipped?: string | null;
  }) => void;
}

/**
 * Run the external sourcing providers in the canonical two-phase order and
 * return a per-provider result map. Discovery providers run in parallel; the
 * enrichment phase is then seeded with the LinkedIn URLs they surfaced.
 *
 * The result is always keyed by EVERY provider in the registry — a provider
 * that was not requested, is disabled, or failed still gets an entry with a
 * `skipped` reason, so callers can render a complete bySource/queries map
 * without special-casing.
 */
export async function runSourcingProviders(
  ctx: SearchContext,
  opts: RunSourcingOptions = {},
): Promise<Record<ProviderId, AdapterResult>> {
  let registry = opts.registry ?? SOURCING_PROVIDERS;
  // Real-run guard: swap the SERP adapter for a no-simulated-fallback variant
  // so a missing key yields a skipped result, never invented people.
  if (opts.allowSimulatedFallback === false && registry.serp) {
    registry = {
      ...registry,
      serp: {
        ...registry.serp,
        run: (ctx) => searchSerp(ctx, { allowSimulatedFallback: false }),
      },
    };
  }
  const requested = opts.requested;
  const wants = (id: ProviderId) => !requested || requested.includes(id);

  const providers = Object.values(registry);
  const discovery = providers.filter((p) => p.kind === "discovery");
  const enrichment = providers.filter((p) => p.kind === "enrichment");

  // Never let a progress observer break the fan-out.
  const notify = (e: Parameters<NonNullable<RunSourcingOptions["onProviderEvent"]>>[0]) => {
    try {
      opts.onProviderEvent?.(e);
    } catch {
      /* observer errors are not the fan-out's problem */
    }
  };
  const observed = async (p: SourcingProvider, seedUrls: string[]): Promise<AdapterResult> => {
    notify({ provider: p.id, label: p.label, phase: "started" });
    const result = await runProvider(p, ctx, seedUrls);
    notify({
      provider: p.id,
      label: p.label,
      phase: "completed",
      count: result.candidates.length,
      skipped: result.skipped ?? null,
    });
    return result;
  };

  // Phase 1 — discovery providers in parallel.
  const discoveryEntries = await Promise.all(
    discovery.map(
      async (p) =>
        [p.id, wants(p.id) ? await observed(p, []) : empty("Not requested")] as const,
    ),
  );
  const results = Object.fromEntries(discoveryEntries) as Record<ProviderId, AdapterResult>;

  // Seed URLs for enrichment: PDL (highest signal) first, then SerpAPI.
  const seedUrls = [...(results.pdl?.candidates ?? []), ...(results.serp?.candidates ?? [])]
    .map((c) => c.linkedinUrl)
    .filter((u): u is string => !!u);

  // Phase 2 — enrichment providers, seeded from discovery.
  for (const p of enrichment) {
    results[p.id] = wants(p.id) ? await observed(p, seedUrls) : empty("Not requested");
  }

  return results;
}

/** Per-provider availability for the /sourcing/status connector feed. */
export function getProviderStatus(
  registry: ProviderRegistry = SOURCING_PROVIDERS,
): Record<ProviderId, ProviderStatus> {
  const out = {} as Record<ProviderId, ProviderStatus>;
  for (const p of Object.values(registry)) {
    const enabled = isProviderEnabled(p.id);
    const configured = p.isConfigured();
    out[p.id] = {
      id: p.id,
      label: p.label,
      kind: p.kind,
      enabled,
      available: enabled && configured,
      apiKey: p.hasApiKey(),
      note: enabled ? p.note() : "Disabled by configuration",
    };
  }
  return out;
}
