/**
 * run-real-no-fabrication.test.ts — Seals "real runs never persist invented
 * people".
 *
 *   1. Unit: with SERP keys absent, `searchSerp(ctx, { allowSimulatedFallback:
 *      false })` returns skipped/empty — no LLM persona generation — and
 *      `runSourcingProviders(ctx, { allowSimulatedFallback: false })` reports
 *      the provider as skipped.
 *   2. Integration: a REAL run whose providers are all unavailable/keyless
 *      completes honestly with ZERO candidates persisted (no candidates,
 *      applications, sourced rows, or intelligence rows), and any
 *      simulated-tagged result that slips through a provider is dropped by the
 *      run's defense-in-depth filter.
 *
 * Fixture ids prefixed `rnf_`; cleaned up in teardown.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  jobsTable,
  agentRunsTable,
  agentRunEventsTable,
  candidatesTable,
  applicationsTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { searchSerp } from "../external-sourcing.js";
import { runSourcingProviders } from "../sourcing-providers.js";
import type { SearchContext } from "../external-sourcing.js";
import { runRealSourcingRun } from "./run-real";

const P = "rnf_";
const TENANT_ID = `${P}tenant`;
const JOB_ID = `${P}job`;

const ctx: SearchContext = {
  jobTitle: "Registered Nurse",
  alternateTitles: [],
  requiredSkills: ["ICU"],
  preferredSkills: [],
  requiredCertifications: [],
  toolsAndSystems: [],
  compliance: [],
  negativeKeywords: [],
  domain: null,
  roleFamily: null,
  seniority: null,
  languages: [],
  location: "",
  workType: null,
  booleanSearchString: null,
  maxResults: 5,
} as any;

function withoutSerpKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { SERP_API_KEY: process.env.SERP_API_KEY, SERPAPI_KEY: process.env.SERPAPI_KEY };
  delete process.env.SERP_API_KEY;
  delete process.env.SERPAPI_KEY;
  return fn().finally(() => {
    if (saved.SERP_API_KEY !== undefined) process.env.SERP_API_KEY = saved.SERP_API_KEY;
    if (saved.SERPAPI_KEY !== undefined) process.env.SERPAPI_KEY = saved.SERPAPI_KEY;
  });
}

test("searchSerp without a key: real-run mode returns skipped/empty, never personas", async () => {
  await withoutSerpKeys(async () => {
    const res = await searchSerp(ctx, { allowSimulatedFallback: false });
    assert.equal(res.candidates.length, 0, "no fabricated candidates");
    assert.ok(res.skipped, "provider reports itself as skipped");
    assert.ok(!/SIMULATED/i.test(res.query), "query not labeled simulated");
  });
});

test("runSourcingProviders(allowSimulatedFallback:false) skips SERP when keyless", async () => {
  await withoutSerpKeys(async () => {
    // Disable the other providers so no external calls fire.
    const savedDisabled = process.env.SOURCING_DISABLED_PROVIDERS;
    process.env.SOURCING_DISABLED_PROVIDERS = "github,pdl,enrichlayer";
    try {
      const results = await runSourcingProviders(ctx, { allowSimulatedFallback: false });
      assert.equal(results.serp.candidates.length, 0, "SERP produced no fabricated candidates");
      assert.ok(results.serp.skipped, "SERP reported skipped");
    } finally {
      if (savedDisabled !== undefined) process.env.SOURCING_DISABLED_PROVIDERS = savedDisabled;
      else delete process.env.SOURCING_DISABLED_PROVIDERS;
    }
  });
});

/* ── Integration: a real run with unavailable providers persists NOTHING ── */

before(async () => {
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: TENANT_ID, name: "NoFab Test Tenant", slug: `${P}tenant-slug` } as any)
    .onConflictDoNothing();
  await dbAdmin
    .insert(jobsTable)
    .values({
      id: JOB_ID,
      tenantId: TENANT_ID,
      title: "Registered Nurse",
      description: "Test job for no-fabrication seal",
      status: "active",
    } as any)
    .onConflictDoNothing();
});

after(async () => {
  await dbAdmin
    .delete(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.jobId, JOB_ID));
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, TENANT_ID));
  await dbAdmin.delete(agentRunEventsTable).where(like(agentRunEventsTable.runId, `${P}%`));
  await dbAdmin.delete(agentRunsTable).where(eq(agentRunsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT_ID));
});

test("real run with unavailable providers completes with ZERO persisted candidates", async () => {
  const run = { id: `${P}run1`, tenantId: TENANT_ID, workOrderId: JOB_ID };
  await dbAdmin.insert(agentRunsTable).values({
    ...run,
    agentType: "sourcing",
    status: "running",
    isSimulated: false,
    triggeredBy: `${P}test`,
    startedAt: new Date(),
  } as any);

  await runRealSourcingRun(run, {
    shortlistSize: 5,
    deps: {
      // Providers all skipped/empty (keyless), EXCEPT one that misbehaves and
      // returns a simulated-tagged persona — the run must drop it.
      runProviders: async () =>
        ({
          github: { candidates: [], query: "", skipped: "disabled" },
          pdl: { candidates: [], query: "", skipped: "no key" },
          serp: {
            candidates: [
              {
                firstName: "Fake",
                lastName: "Person",
                email: null,
                source: "serp",
                skills: [],
                rawData: { simulated: true },
              },
            ],
            query: "SERP: … (SIMULATED — no SERP_API_KEY)",
          },
          enrichlayer: { candidates: [], query: "", skipped: "no key" },
        }) as any,
      scoreCandidates: async (cands: any[]) => cands.map((c) => ({ ...c, matchScore: 99 })),
      classifyLocations: async () => new Map(),
      searchInternal: async () => ({ candidates: [] as any[], query: "internal: mocked" }),
    },
  });

  const [runRow] = await dbAdmin.select().from(agentRunsTable).where(eq(agentRunsTable.id, run.id));
  assert.equal(runRow.status, "completed", "run completes honestly");
  assert.equal((runRow.summary as any)?.found ?? 0, 0, "summary reports zero found");

  const cands = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, TENANT_ID));
  assert.equal(cands.length, 0, "no fabricated candidates persisted");

  const apps = await dbAdmin
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, JOB_ID));
  assert.equal(apps.length, 0, "no applications persisted");

  const intel = await dbAdmin
    .select({ id: candidateJobIntelligenceTable.id })
    .from(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.jobId, JOB_ID));
  assert.equal(intel.length, 0, "no intelligence rows persisted");
});
