/**
 * sourcing-providers.test.ts — Sourcing provider adapter layer (Task #28)
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * The adapter layer is the abstraction boundary in front of the external
 * sourcing providers. These tests pin the three guarantees the layer must keep,
 * using an INJECTED fake registry so nothing touches the network or env keys:
 *
 *  1. CONFIG-DRIVEN — a provider can be disabled via SOURCING_DISABLED_PROVIDERS
 *     without touching call sites; `requested` restricts the fan-out; and the
 *     status feed reflects both.
 *  2. GRACEFUL DEGRADATION — a provider that THROWS never breaks the fan-out;
 *     it yields a clear `skipped` reason and the other providers still run.
 *  3. TWO-PHASE ORDERING — discovery runs first, then enrichment is seeded with
 *     the discovery LinkedIn URLs (PDL first, then SerpAPI).
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:sourcing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProviderEnabled,
  runSourcingProviders,
  getProviderStatus,
  SOURCING_PROVIDERS,
  type ProviderRegistry,
  type SourcingProvider,
} from "./sourcing-providers";
import type { SearchContext, AdapterResult } from "./external-sourcing";

const CTX: SearchContext = {
  jobTitle: "Test Engineer",
  alternateTitles: [],
  requiredSkills: [],
  preferredSkills: [],
  requiredCertifications: [],
  toolsAndSystems: [],
  compliance: [],
  negativeKeywords: [],
  domain: null,
  roleFamily: null,
  seniority: null,
  location: "",
  booleanSearchString: null,
  maxResults: 10,
};

function cand(id: string, linkedinUrl: string | null): any {
  return {
    id, firstName: id, lastName: "T", currentTitle: "", currentCompany: "",
    location: "", email: null, linkedinUrl, source: "pdl", skills: [],
  };
}

/** A fully fake registry — records the seed URLs each provider was handed. */
function makeFakeRegistry(seen: { id: string; seedUrls: string[] }[]): ProviderRegistry {
  const mk = (
    id: SourcingProvider["id"],
    kind: SourcingProvider["kind"],
    run: SourcingProvider["run"],
  ): SourcingProvider => ({
    id, kind, label: id, isConfigured: () => true, hasApiKey: () => true, note: () => "ok", run,
  });
  return {
    github: mk("github", "discovery", async () => ({ candidates: [cand("gh1", null)], query: "gh" })),
    pdl: mk("pdl", "discovery", async () => ({ candidates: [cand("pdl1", "https://lkdn/pdl1")], query: "pdl" })),
    serp: mk("serp", "discovery", async () => ({ candidates: [cand("serp1", "https://lkdn/serp1")], query: "serp" })),
    enrichlayer: mk("enrichlayer", "enrichment", async (_ctx, seedUrls) => {
      seen.push({ id: "enrichlayer", seedUrls });
      return { candidates: [cand("el1", null)], query: "el" } as AdapterResult;
    }),
  };
}

/* ── Two-phase ordering + seed URLs ──────────────────────────────────────── */
test("enrichment phase is seeded with discovery LinkedIn URLs (PDL first, then SERP)", async () => {
  const seen: { id: string; seedUrls: string[] }[] = [];
  const registry = makeFakeRegistry(seen);
  const results = await runSourcingProviders(CTX, { registry });

  assert.equal(results.github.candidates.length, 1);
  assert.equal(results.pdl.candidates.length, 1);
  assert.equal(results.serp.candidates.length, 1);
  assert.equal(results.enrichlayer.candidates.length, 1);

  // EnrichLayer must have been handed the discovery URLs, PDL before SERP.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].seedUrls, ["https://lkdn/pdl1", "https://lkdn/serp1"]);
});

/* ── requested restricts the fan-out ─────────────────────────────────────── */
test("`requested` restricts which providers run; others return a skipped entry", async () => {
  const seen: { id: string; seedUrls: string[] }[] = [];
  const registry = makeFakeRegistry(seen);
  const results = await runSourcingProviders(CTX, { registry, requested: ["serp"] });

  // Every provider still gets an entry — un-requested ones are skipped, empty.
  assert.equal(results.serp.candidates.length, 1);
  assert.equal(results.github.candidates.length, 0);
  assert.ok(results.github.skipped);
  assert.equal(results.pdl.candidates.length, 0);
  assert.equal(results.enrichlayer.candidates.length, 0);
  assert.ok(results.enrichlayer.skipped);

  // Only SERP discovered a URL, so enrichment would have been seeded from it —
  // but enrichlayer wasn't requested, so it never ran.
  assert.equal(seen.length, 0);
});

/* ── Graceful degradation when an adapter throws ─────────────────────────── */
test("a throwing provider degrades gracefully without breaking the fan-out", async () => {
  const seen: { id: string; seedUrls: string[] }[] = [];
  const registry = makeFakeRegistry(seen);
  // Make PDL blow up mid-discovery.
  registry.pdl.run = async () => { throw new Error("boom"); };

  const results = await runSourcingProviders(CTX, { registry });

  // PDL failed cleanly...
  assert.equal(results.pdl.candidates.length, 0);
  assert.match(results.pdl.skipped ?? "", /error/i);
  // ...while every other provider still produced results.
  assert.equal(results.github.candidates.length, 1);
  assert.equal(results.serp.candidates.length, 1);
  assert.equal(results.enrichlayer.candidates.length, 1);
  // Enrichment still seeded from SERP (PDL produced nothing).
  assert.deepEqual(seen[0].seedUrls, ["https://lkdn/serp1"]);
});

/* ── Hung provider degrades via timeout (does not block the fan-out) ──────── */
test("a hung provider times out gracefully instead of blocking the fan-out", async () => {
  const prev = process.env.SOURCING_DISCOVERY_TIMEOUT_MS;
  process.env.SOURCING_DISCOVERY_TIMEOUT_MS = "50";
  try {
    const seen: { id: string; seedUrls: string[] }[] = [];
    const registry = makeFakeRegistry(seen);
    // PDL hangs forever — never resolves, never throws.
    registry.pdl.run = () => new Promise<AdapterResult>(() => {});

    const start = Date.now();
    const results = await runSourcingProviders(CTX, { registry });
    const elapsed = Date.now() - start;

    // The fan-out completed despite the hang, well within a sane bound.
    assert.ok(elapsed < 5_000, `fan-out should not block on a hung provider (took ${elapsed}ms)`);

    // PDL degraded to a clear timeout skip...
    assert.equal(results.pdl.candidates.length, 0);
    assert.match(results.pdl.skipped ?? "", /timed out/i);
    // ...while every other provider still produced results.
    assert.equal(results.github.candidates.length, 1);
    assert.equal(results.serp.candidates.length, 1);
    assert.equal(results.enrichlayer.candidates.length, 1);
    // Enrichment still seeded from SERP (PDL produced nothing).
    assert.deepEqual(seen[0].seedUrls, ["https://lkdn/serp1"]);
  } finally {
    if (prev === undefined) delete process.env.SOURCING_DISCOVERY_TIMEOUT_MS;
    else process.env.SOURCING_DISCOVERY_TIMEOUT_MS = prev;
  }
});

/* ── Invalid timeout env falls back to the default (no truncation/hang) ───── */
test("an invalid timeout env value is ignored in favour of the default", async () => {
  const prev = process.env.SOURCING_DISCOVERY_TIMEOUT_MS;
  // Non-numeric / non-positive values must NOT become the timeout (which would
  // make a 0ms ceiling truncate every run, or a NaN ceiling never fire).
  for (const bad of ["0", "-5", "abc", ""]) {
    process.env.SOURCING_DISCOVERY_TIMEOUT_MS = bad;
    const seen: { id: string; seedUrls: string[] }[] = [];
    const registry = makeFakeRegistry(seen);
    const results = await runSourcingProviders(CTX, { registry });
    // Providers resolve instantly here; with the default ceiling they complete
    // normally rather than being timed out by a bogus 0/NaN value.
    assert.equal(results.github.candidates.length, 1, `bad value ${JSON.stringify(bad)}`);
    assert.equal(results.pdl.candidates.length, 1, `bad value ${JSON.stringify(bad)}`);
    assert.equal(results.pdl.skipped ?? "", "", `bad value ${JSON.stringify(bad)}`);
  }
  if (prev === undefined) delete process.env.SOURCING_DISCOVERY_TIMEOUT_MS;
  else process.env.SOURCING_DISCOVERY_TIMEOUT_MS = prev;
});

/* ── Config-driven disabling ─────────────────────────────────────────────── */
test("SOURCING_DISABLED_PROVIDERS disables a provider at the run layer", async () => {
  const prev = process.env.SOURCING_DISABLED_PROVIDERS;
  process.env.SOURCING_DISABLED_PROVIDERS = "pdl, enrichlayer";
  try {
    assert.equal(isProviderEnabled("pdl"), false);
    assert.equal(isProviderEnabled("enrichlayer"), false);
    assert.equal(isProviderEnabled("serp"), true);

    const seen: { id: string; seedUrls: string[] }[] = [];
    const registry = makeFakeRegistry(seen);
    const results = await runSourcingProviders(CTX, { registry });

    assert.equal(results.pdl.candidates.length, 0);
    assert.match(results.pdl.skipped ?? "", /disabled by configuration/i);
    assert.equal(results.enrichlayer.candidates.length, 0);
    assert.match(results.enrichlayer.skipped ?? "", /disabled by configuration/i);
    assert.equal(results.github.candidates.length, 1);
    assert.equal(results.serp.candidates.length, 1);
    // Disabled enrichment never ran.
    assert.equal(seen.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SOURCING_DISABLED_PROVIDERS;
    else process.env.SOURCING_DISABLED_PROVIDERS = prev;
  }
});

/* ── Status feed reflects config ─────────────────────────────────────────── */
test("getProviderStatus reflects config-disable and configured state", async () => {
  const prev = process.env.SOURCING_DISABLED_PROVIDERS;
  process.env.SOURCING_DISABLED_PROVIDERS = "serp";
  try {
    const registry = makeFakeRegistry([]);
    const status = getProviderStatus(registry);
    assert.equal(status.serp.enabled, false);
    assert.equal(status.serp.available, false);
    assert.match(status.serp.note, /disabled by configuration/i);
    // A non-disabled, configured provider stays available.
    assert.equal(status.github.enabled, true);
    assert.equal(status.github.available, true);
  } finally {
    if (prev === undefined) delete process.env.SOURCING_DISABLED_PROVIDERS;
    else process.env.SOURCING_DISABLED_PROVIDERS = prev;
  }
});

/* ── Built-in registry shape ─────────────────────────────────────────────── */
test("built-in registry exposes the four providers with correct kinds", () => {
  assert.deepEqual(Object.keys(SOURCING_PROVIDERS).sort(), ["enrichlayer", "github", "pdl", "serp"]);
  assert.equal(SOURCING_PROVIDERS.github.kind, "discovery");
  assert.equal(SOURCING_PROVIDERS.pdl.kind, "discovery");
  assert.equal(SOURCING_PROVIDERS.serp.kind, "discovery");
  assert.equal(SOURCING_PROVIDERS.enrichlayer.kind, "enrichment");
});
