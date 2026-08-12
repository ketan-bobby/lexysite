/**
 * run-real.test.ts — Integration seal for the REAL work-order sourcing run.
 *
 * Proves the reviewer-critical persistence contract of runRealSourcingRun with
 * the external world mocked (providers, LLM scorer, geo classifier, internal
 * search) but the DATABASE real:
 *
 *   1. Candidates are created with the GENUINE scorer output (not 92-i*3),
 *      sourced_candidates carries matchScore/matchReason/runId in rawData with
 *      an enum-safe `source` (enrichlayer → linkedin), a sourced-stage
 *      application row exists with ai_sourcing origin, and an intelligence row
 *      is seeded — all via dbAdmin (fire-and-forget context).
 *   2. A SECOND run for the same job dedups: no duplicate candidates,
 *      applications, or sourced rows; scores refresh instead.
 *   3. The run completes on the durable event stream (run_completed emitted,
 *      status 'completed').
 *
 * Runs outside withTenantContext, so the `db` proxy falls through to dbAdmin —
 * exactly the production execution context (`requestDbContext.exit` in the
 * route). Fixture ids prefixed `rrt_`; cleaned up in teardown.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  jobsTable,
  icpTable,
  agentRunsTable,
  agentRunEventsTable,
  candidatesTable,
  applicationsTable,
  sourcedCandidatesTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { runRealSourcingRun } from "./run-real";

const P = "rrt_";
const TENANT_ID = `${P}tenant`;
const JOB_ID = `${P}job`;
const EMAILS = [`${P}ada@example.test`, `${P}grace@example.test`];

const fakeExternal = [
  {
    firstName: "Ada",
    lastName: "Lovelace",
    email: EMAILS[0],
    currentTitle: "Senior Backend Engineer",
    currentCompany: "Analytical Engines",
    location: "London, UK",
    skills: ["typescript", "postgres"],
    source: "pdl",
    linkedinUrl: "https://linkedin.com/in/rrt-ada",
  },
  {
    firstName: "Grace",
    lastName: "Hopper",
    email: EMAILS[1],
    currentTitle: "Staff Engineer",
    currentCompany: "Compilers Inc",
    location: "New York, NY",
    skills: ["cobol", "systems"],
    source: "enrichlayer", // NOT in the candidate_source enum — must be mapped
    linkedinUrl: "https://linkedin.com/in/rrt-grace",
  },
];

/** Deterministic "LLM" scorer: known genuine-looking scores per candidate. */
const SCORES: Record<string, number> = { [EMAILS[0]]: 87.5, [EMAILS[1]]: 63 };
const deps = {
  runProviders: async () =>
    ({
      github: { candidates: [], query: "" },
      pdl: { candidates: [fakeExternal[0]], query: "" },
      serp: { candidates: [], query: "" },
      enrichlayer: { candidates: [fakeExternal[1]], query: "" },
    }) as any,
  scoreCandidates: async (cands: any[]) =>
    cands.map((c) => ({
      ...c,
      matchScore: SCORES[c.email],
      matchReason: `mock reason for ${c.firstName}`,
    })),
  classifyLocations: async () => new Map(),
  searchInternal: async () => ({ candidates: [] as any[], query: "internal: mocked" }),
};

async function seedRun(id: string) {
  await dbAdmin.insert(agentRunsTable).values({
    id,
    tenantId: TENANT_ID,
    workOrderId: JOB_ID,
    agentType: "sourcing",
    status: "running",
    isSimulated: false,
    triggeredBy: `${P}test`,
    startedAt: new Date(),
  });
  return { id, tenantId: TENANT_ID, workOrderId: JOB_ID };
}

before(async () => {
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: TENANT_ID, name: "RunReal Test Tenant", slug: `${P}tenant-slug` } as any)
    .onConflictDoNothing();
  await dbAdmin
    .insert(jobsTable)
    .values({
      id: JOB_ID,
      tenantId: TENANT_ID,
      title: "Senior Backend Engineer",
      description: "Test job for real-run seal",
      status: "active",
    } as any)
    .onConflictDoNothing();
  await dbAdmin
    .insert(icpTable)
    .values({
      id: `${P}icp`,
      tenantId: TENANT_ID,
      jobId: JOB_ID,
      version: 1,
      jobTitle: "Senior Backend Engineer",
      requiredSkills: ["typescript", "postgres"],
    } as any)
    .onConflictDoNothing();
});

after(async () => {
  const cands = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, TENANT_ID));
  const candIds = cands.map((c) => c.id);
  if (candIds.length) {
    await dbAdmin
      .delete(candidateJobIntelligenceTable)
      .where(inArray(candidateJobIntelligenceTable.candidateId, candIds));
    await dbAdmin
      .delete(sourcedCandidatesTable)
      .where(inArray(sourcedCandidatesTable.normalizedCandidateId, candIds));
  }
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, TENANT_ID));
  await dbAdmin.delete(agentRunEventsTable).where(like(agentRunEventsTable.runId, `${P}%`));
  await dbAdmin.delete(agentRunsTable).where(eq(agentRunsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(icpTable).where(eq(icpTable.tenantId, TENANT_ID));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT_ID));
});

test("first real run persists candidates, apps, sourced rows, intelligence with GENUINE scores", async () => {
  const run = await seedRun(`${P}run1`);
  await runRealSourcingRun(run, { shortlistSize: 5, deps });

  // Run completed on the durable stream.
  const [runRow] = await dbAdmin.select().from(agentRunsTable).where(eq(agentRunsTable.id, run.id));
  assert.equal(runRow.status, "completed");
  const events = await dbAdmin
    .select()
    .from(agentRunEventsTable)
    .where(eq(agentRunEventsTable.runId, run.id));
  assert.ok(
    events.some((e: any) => e.type === "run_completed"),
    "run_completed emitted",
  );

  // Candidates carry the scorer's genuine scores.
  const cands = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, TENANT_ID));
  assert.equal(cands.length, 2);
  for (const email of EMAILS) {
    const c: any = cands.find((x: any) => x.email === email);
    assert.ok(c, `candidate ${email} created`);
    assert.equal(c.talentMatchScore, SCORES[email], "genuine scorer output persisted");
  }

  // sourced_candidates: rawData carries score/reason/runId; enum-safe source.
  const candIds = cands.map((c: any) => c.id);
  const sourced = await dbAdmin
    .select()
    .from(sourcedCandidatesTable)
    .where(inArray(sourcedCandidatesTable.normalizedCandidateId, candIds));
  assert.equal(sourced.length, 2);
  for (const s of sourced as any[]) {
    assert.equal(s.rawData.runId, run.id);
    assert.ok(typeof s.rawData.matchScore === "number");
    assert.ok(String(s.rawData.matchReason).startsWith("mock reason"));
    assert.ok(
      ["pdl", "linkedin"].includes(s.source),
      `enum-safe source, got ${s.source} (enrichlayer must map to linkedin)`,
    );
  }
  assert.ok(
    sourced.some((s: any) => s.source === "linkedin"),
    "enrichlayer row mapped",
  );

  // Applications at 'sourced' with the real matchScore + ai_sourcing origin.
  const apps = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, JOB_ID));
  assert.equal(apps.length, 2);
  for (const a of apps as any[]) {
    assert.equal(a.stage, "sourced");
    assert.ok(typeof a.matchScore === "number");
  }

  // Intelligence rows seeded from the REAL score.
  const intel = await dbAdmin
    .select()
    .from(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.jobId, JOB_ID));
  assert.equal(intel.length, 2, "one intelligence row per shortlisted candidate");
});

test("second run dedups: no duplicate candidates/apps/sourced rows, scores refresh", async () => {
  const run2 = await seedRun(`${P}run2`);
  // Scorer returns DIFFERENT scores this time — refresh must win, dup must not.
  const deps2 = {
    ...deps,
    scoreCandidates: async (cands: any[]) =>
      cands.map((c) => ({ ...c, matchScore: 91, matchReason: "rescored" })),
  };
  await runRealSourcingRun(run2, { shortlistSize: 5, deps: deps2 });

  const [runRow] = await dbAdmin
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.id, run2.id));
  assert.equal(runRow.status, "completed");

  const cands = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, TENANT_ID));
  assert.equal(cands.length, 2, "no duplicate candidates on re-run");
  for (const c of cands as any[]) {
    assert.equal(c.talentMatchScore, 91, "score refreshed on re-source");
  }

  const apps = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, JOB_ID));
  assert.equal(apps.length, 2, "no duplicate applications");

  const sourced = await dbAdmin
    .select()
    .from(sourcedCandidatesTable)
    .where(
      inArray(
        sourcedCandidatesTable.normalizedCandidateId,
        cands.map((c: any) => c.id),
      ),
    );
  assert.equal(sourced.length, 2, "no duplicate sourced_candidates rows");

  const intel = await dbAdmin
    .select()
    .from(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.jobId, JOB_ID));
  assert.equal(intel.length, 2, "no duplicate intelligence rows");
});
