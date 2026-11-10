import test from "node:test";
import assert from "node:assert/strict";
import type { SourcingLimits } from "@workspace/db";
import { analyzeSourcingCosts } from "./sourcing-cost-analysis";

const limits: SourcingLimits = {
  allowExternal: true,
  providers: ["pdl", "serp", "enrichlayer"],
  maxCandidates: 10,
  maxDurationSeconds: 300,
  maxRuns: 3,
  runBudgetCents: 500,
  totalBudgetCents: 1500,
};
const rate = (microsPerCredit: number) => ({
  microsPerCredit,
  basis: "prepaid_allocation" as const,
  source: "fixture-only plan",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
test("unconfigured rates never become free or complete-run quotes", () => {
  const p = analyzeSourcingCosts(limits);
  assert.equal(p.knownAllowanceMicros, 0);
  assert.equal(p.complete, false);
  assert.equal(p.planningOnly, true);
  assert.deepEqual(p.missingProviders, ["pdl", "serp", "enrichlayer", "model", "embedding"]);
});
test("allowance counts discarded PDL tiers, SERP fallback and every enrichment seed", () => {
  const p = analyzeSourcingCosts({
    ...limits,
    accountRates: {
      pdl: rate(100_000),
      serp: rate(25_000),
      enrichlayer: rate(30_000),
    },
  });
  assert.deepEqual(
    p.rows.slice(1, 4).map((r) => r.credits),
    [40, 2, 40],
  );
  assert.equal(p.knownAllowanceMicros, 5_250_000);
  assert.equal(p.exceedsRunCap, true);
  assert.equal(p.complete, false); // all data-vendor rates still do not price AI.
});
test("expiry and invalid zero rates suppress price calculation", () => {
  const p = analyzeSourcingCosts(
    {
      ...limits,
      accountRates: {
        pdl: { ...rate(1), expiresAt: "2026-01-01T00:00:00.000Z" },
        serp: rate(0),
      },
    },
    new Date("2026-10-05T00:00:00Z"),
  );
  assert.equal(p.rows[1].rateStatus, "expired");
  assert.equal(p.rows[1].allowanceMicros, null);
  assert.equal(p.rows[2].allowanceMicros, null);
});
test("employee-only and unchecked external scope do not allocate vendor cost", () => {
  const p = analyzeSourcingCosts({
    ...limits,
    allowExternal: false,
    accountRates: { pdl: rate(100_000) },
  });
  assert.equal(p.knownAllowanceMicros, 0);
  assert.deepEqual(p.missingProviders, ["model", "embedding"]);
});
test("GitHub public REST has explicit zero vendor fee, not zero scoring cost", () => {
  const p = analyzeSourcingCosts({ ...limits, providers: ["github"] });
  assert.equal(p.rows[0].allowanceMicros, 0);
  assert.deepEqual(p.missingProviders, ["model", "embedding"]);
});
test("EnrichLayer alone has no seeds; one upstream provider has N possible URLs", () => {
  assert.equal(analyzeSourcingCosts({ ...limits, providers: ["enrichlayer"] }).rows[3].credits, 0);
  assert.equal(
    analyzeSourcingCosts({ ...limits, providers: ["serp", "enrichlayer"] }).rows[3].credits,
    20,
  );
});
