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
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
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
import { isFeeEligible } from "../fee-ledger";

// Interrupted or independently launched runs must never reuse this fixture's
// tenant/job, even when a previous process could not finish its teardown.
const P = `rrt_${randomUUID().replaceAll("-", "")}_`;
const TENANT_ID = `${P}tenant`;
const JOB_ID = `${P}job`;
const INTERNAL_EMPLOYEE_ID = `${P}employee-candidate`;
const INTERNAL_EMPLOYEE_EMAIL = `${P}employee@example.test`;
const KNOWN_CANDIDATE_ID = `${P}known-candidate`;
const KNOWN_CANDIDATE_EMAIL = `${P}known@example.test`;
const PROTECTED_EMPLOYEE_ID = `${P}protected-employee`;
const PROTECTED_EMPLOYEE_EMAIL = `${P}protected-employee@example.test`;
const PROTECTED_ERASED_ID = `${P}protected-erased`;
const PROTECTED_ERASED_EMAIL = `${P}protected-erased@example.test`;
const PROTECTED_PLATFORM_ID = `${P}protected-platform`;
const PROTECTED_PLATFORM_EMAIL = `${P}protected-platform@example.test`;
const ELIGIBLE_AFTER_PROTECTED_EMAIL = `${P}eligible-after-protected@example.test`;
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

async function seedRunForJob(id: string, workOrderId: string) {
  await dbAdmin.insert(agentRunsTable).values({
    id,
    tenantId: TENANT_ID,
    workOrderId,
    agentType: "sourcing",
    status: "running",
    isSimulated: false,
    triggeredBy: `${P}test`,
    startedAt: new Date(),
  });
  return { id, tenantId: TENANT_ID, workOrderId };
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
  // Scope by the disposable tenant, not just candidates that still exist:
  // interrupted runs can otherwise leave intelligence for a removed candidate.
  await dbAdmin
    .delete(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.tenantId, TENANT_ID));
  const cands = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, TENANT_ID));
  const candIds = cands.map((c) => c.id);
  if (candIds.length) {
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
  assert.equal(runRow.status, "completed", runRow.error ?? "Sourcing run should complete");
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

test("internal mobility uses only the exact-tenant employee pool and shortlists its existing identity", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: true } as any)
    .where(eq(jobsTable.id, JOB_ID));
  await dbAdmin
    .insert(candidatesTable)
    .values({
      id: INTERNAL_EMPLOYEE_ID,
      tenantId: TENANT_ID,
      pool: "tenant",
      isCurrentEmployee: true,
      source: "hris_sync",
      firstName: "Internal",
      lastName: "Employee",
      email: INTERNAL_EMPLOYEE_EMAIL,
      currentTitle: "Senior Backend Engineer",
      currentCompany: "RunReal Test Tenant",
      skills: ["typescript", "postgres"],
    } as any)
    .onConflictDoNothing();

  let providerCalls = 0;
  const internalRun = await seedRun(`${P}run-internal-mobility`);
  await runRealSourcingRun(internalRun, {
    shortlistSize: 5,
    deps: {
      runProviders: async () => {
        providerCalls++;
        throw new Error("External providers must not run in Internal Mobility mode");
      },
      scoreCandidates: async (cands: any[]) =>
        cands.map((candidate) => ({
          ...candidate,
          matchScore: 96,
          matchReason: "Strong internal skills and title fit",
        })),
      classifyLocations: async () => new Map(),
      searchInternal: async (_ctx: any, scope: any, _dbc: any, mode: any) => {
        assert.equal(
          scope,
          TENANT_ID,
          "employee search uses the job's exact tenant, not agency scope",
        );
        assert.equal(mode, "internal_mobility", "stored job mode reaches shared internal search");
        return {
          candidates: [
            {
              id: `internal_${INTERNAL_EMPLOYEE_ID}`,
              candidateId: INTERNAL_EMPLOYEE_ID,
              source: "internal",
              isCurrentEmployee: true,
              firstName: "Internal",
              lastName: "Employee",
              email: INTERNAL_EMPLOYEE_EMAIL,
              currentTitle: "Senior Backend Engineer",
              currentCompany: "RunReal Test Tenant",
              location: "London, UK",
              skills: ["typescript", "postgres"],
              linkedinUrl: "",
            },
          ],
          query: "Internal Mobility employee search",
        } as any;
      },
    },
  });
  assert.equal(providerCalls, 0, "provider registry was not invoked");

  const employeeRows = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.email, INTERNAL_EMPLOYEE_EMAIL));
  assert.equal(employeeRows.length, 1, "internal candidate row identity was reused");
  assert.equal(employeeRows[0].id, INTERNAL_EMPLOYEE_ID);
  assert.equal(employeeRows[0].talentMatchScore, 96, "employee received the ICP scorer's score");

  const [application] = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, JOB_ID),
        eq(applicationsTable.candidateId, INTERNAL_EMPLOYEE_ID),
      ),
    );
  assert.ok(application, "existing employee is attached to this work order");
  assert.equal(application.stage, "sourced");
  assert.equal((application.originEvidence as any)?.channel, "internal_mobility");

  const [intelligence] = await dbAdmin
    .select()
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        eq(candidateJobIntelligenceTable.jobId, JOB_ID),
        eq(candidateJobIntelligenceTable.candidateId, INTERNAL_EMPLOYEE_ID),
      ),
    );
  assert.ok(intelligence, "employee shortlist is visible to the Decision Queue");

  const [runRow] = await dbAdmin
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.id, internalRun.id));
  assert.equal((runRow.summary as any)?.sourceSummary?.internalMobility, true);
  assert.equal((runRow.summary as any)?.sourceSummary?.bySource?.github, 0);

  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: false } as any)
    .where(eq(jobsTable.id, JOB_ID));
});

test("Internal Mobility with no ICP and no employees reports an explicit empty result without fallback", async () => {
  const noIcpJobId = `${P}no-icp-job`;
  await dbAdmin
    .insert(jobsTable)
    .values({
      id: noIcpJobId,
      tenantId: TENANT_ID,
      title: "Unfilled role",
      description: "Internal mobility empty-result fixture",
      status: "active",
      internalMobility: true,
    } as any)
    .onConflictDoNothing();
  const run = await seedRunForJob(`${P}run-empty-mobility`, noIcpJobId);
  await runRealSourcingRun(run, {
    deps: {
      runProviders: async () => {
        throw new Error("empty Internal Mobility must not fall back to external providers");
      },
      scoreCandidates: async () => {
        throw new Error("no-ICP empty search should not invoke scoring");
      },
      classifyLocations: async () => new Map(),
      searchInternal: async (_ctx: any, scope: any, _dbc: any, mode: any) => {
        assert.equal(scope, TENANT_ID);
        assert.equal(mode, "internal_mobility");
        return { candidates: [], query: "Internal Mobility: no matching employees" } as any;
      },
    },
  });

  const [runRow] = await dbAdmin.select().from(agentRunsTable).where(eq(agentRunsTable.id, run.id));
  assert.equal(runRow.status, "completed");
  assert.equal((runRow.summary as any)?.found, 0);
  assert.equal((runRow.summary as any)?.sourceSummary?.icpMissing, true);
  assert.equal((runRow.summary as any)?.sourceSummary?.noMatches, true);
  const events = await dbAdmin
    .select()
    .from(agentRunEventsTable)
    .where(eq(agentRunEventsTable.runId, run.id));
  assert.ok(
    events.some((event: any) => /no current employees.*no external fallback/i.test(event.message)),
    "empty-state event explains that we searched and did not fall back externally",
  );
});

test("provider identities protected by employee, erasure, or pool status do not crowd the shortlist", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: false } as any)
    .where(eq(jobsTable.id, JOB_ID));
  await dbAdmin.insert(candidatesTable).values([
    {
      id: PROTECTED_EMPLOYEE_ID,
      tenantId: TENANT_ID,
      pool: "tenant",
      isCurrentEmployee: true,
      source: "hris_sync",
      firstName: "Protected",
      lastName: "Employee",
      email: PROTECTED_EMPLOYEE_EMAIL,
    },
    {
      id: PROTECTED_ERASED_ID,
      tenantId: TENANT_ID,
      pool: "tenant",
      dataErasedAt: new Date(),
      source: "manual",
      firstName: "Protected",
      lastName: "Erased",
      email: PROTECTED_ERASED_EMAIL,
    },
    {
      id: PROTECTED_PLATFORM_ID,
      tenantId: TENANT_ID,
      pool: "platform",
      source: "manual",
      firstName: "Protected",
      lastName: "Platform",
      email: PROTECTED_PLATFORM_EMAIL,
    },
  ] as any);
  const externalCandidates = [
    [PROTECTED_EMPLOYEE_EMAIL, "Protected", "Employee"],
    [PROTECTED_ERASED_EMAIL, "Protected", "Erased"],
    [PROTECTED_PLATFORM_EMAIL, "Protected", "Platform"],
    [ELIGIBLE_AFTER_PROTECTED_EMAIL, "Eligible", "Candidate"],
  ].map(([email, firstName, lastName], index) => ({
    email,
    firstName,
    lastName,
    currentTitle: "Senior Backend Engineer",
    location: "London, UK",
    skills: ["typescript", "postgres"],
    source: "pdl",
    linkedinUrl: `https://linkedin.com/in/${P}crowdout-${index}`,
  }));
  let scoredEmails: string[] = [];
  const run = await seedRun(`${P}run-protected-crowdout`);
  await runRealSourcingRun(run, {
    shortlistSize: 1,
    deps: {
      runProviders: async () =>
        ({
          github: { candidates: [], query: "" },
          pdl: { candidates: externalCandidates, query: "" },
          serp: { candidates: [], query: "" },
          enrichlayer: { candidates: [], query: "" },
        }) as any,
      scoreCandidates: async (cands: any[]) => {
        scoredEmails = cands.map((candidate) => candidate.email);
        return cands.map((candidate) => ({
          ...candidate,
          matchScore: candidate.email === ELIGIBLE_AFTER_PROTECTED_EMAIL ? 82 : 100,
          matchReason: "mock ICP score",
        }));
      },
      classifyLocations: async () => new Map(),
      searchInternal: async () => ({ candidates: [], query: "internal: mocked" }),
    },
  });

  assert.deepEqual(
    scoredEmails,
    [ELIGIBLE_AFTER_PROTECTED_EMAIL],
    "protected identities are resolved and removed before candidate ranking/shortlist truncation",
  );
  const [eligible] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.email, ELIGIBLE_AFTER_PROTECTED_EMAIL));
  assert.ok(eligible, "the eligible candidate behind protected high-scoring results was persisted");
  const [application] = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(eq(applicationsTable.jobId, JOB_ID), eq(applicationsTable.candidateId, eligible.id)),
    );
  assert.ok(application, "the eligible candidate received the job-scoped sourced link");
  assert.equal((application.originEvidence as any)?.channel, "ai_sourcing");
});

test("provider rediscovery reuses a known candidate and records non-fee Known Talent origin", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: false } as any)
    .where(eq(jobsTable.id, JOB_ID));
  await dbAdmin
    .insert(candidatesTable)
    .values({
      id: KNOWN_CANDIDATE_ID,
      tenantId: TENANT_ID,
      pool: "tenant",
      isCurrentEmployee: false,
      source: "career_site",
      firstName: "Known",
      lastName: "Candidate",
      email: KNOWN_CANDIDATE_EMAIL,
      currentTitle: "Senior Backend Engineer",
      skills: ["typescript", "postgres"],
    } as any)
    .onConflictDoNothing();
  const run = await seedRun(`${P}run-known-reuse`);
  await runRealSourcingRun(run, {
    shortlistSize: 1,
    deps: {
      runProviders: async () =>
        ({
          github: { candidates: [], query: "" },
          pdl: {
            candidates: [
              {
                firstName: "Known",
                lastName: "Candidate",
                email: KNOWN_CANDIDATE_EMAIL,
                currentTitle: "Senior Backend Engineer",
                skills: ["typescript", "postgres"],
                source: "pdl",
                linkedinUrl: `https://linkedin.com/in/${P}known`,
              },
            ],
            query: "",
          },
          serp: { candidates: [], query: "" },
          enrichlayer: { candidates: [], query: "" },
        }) as any,
      scoreCandidates: async (cands: any[]) =>
        cands.map((candidate) => ({
          ...candidate,
          matchScore: 84,
          matchReason: "known candidate rediscovered",
        })),
      classifyLocations: async () => new Map(),
      searchInternal: async () => ({ candidates: [], query: "internal: mocked" }),
    },
  });

  const matchingRows = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.email, KNOWN_CANDIDATE_EMAIL));
  assert.equal(matchingRows.length, 1, "the canonical tenant candidate was reused");
  assert.equal(matchingRows[0].id, KNOWN_CANDIDATE_ID);
  const [application] = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, JOB_ID),
        eq(applicationsTable.candidateId, KNOWN_CANDIDATE_ID),
      ),
    );
  assert.ok(application, "the reused candidate is linked to the job");
  assert.equal((application.originEvidence as any)?.channel, "known_talent_rediscovery");
  assert.equal(isFeeEligible(application.entryType, application.originEvidence), false);
});
