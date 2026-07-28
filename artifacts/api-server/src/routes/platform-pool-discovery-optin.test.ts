/**
 * platform-pool-discovery-optin.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PERMANENT regression net for the July 2026 ruling: portal access and
 * platform-pool discovery are DECOUPLED.
 *
 * INVARIANT PROVEN, per intake path:
 *   A candidate created via (1) public apply-to-job, (2) recruiter portal
 *   invite (ensureCandidateUser), or (3) public self-register is NOT in the
 *   platform pool — i.e. not discoverable by other licensed tenants — until
 *   an explicit opt-in through the chokepoint (grantDiscoveryOptIn) flips
 *   them. After opt-in they ARE in the platform pool with an auditable
 *   consent row (version + disclosure snapshot + capture context), and
 *   withdrawal restores their pre-opt-in pool while keeping the audit row.
 *
 * History: ensureCandidateUser used to promote EVERY portal-provisioned
 * candidate to pool='platform' (apply + invite paths), and completing the
 * baseline interview auto-promoted self-registered candidates. All three
 * silent promotions are removed; this file keeps them out.
 *
 * Email is forced into the simulated-send branch (SES creds removed) so no
 * real mail is dispatched to @dopt.test fixtures.
 * Harness mirrors career-register-enumeration.test.ts.
 */
/* MUST be the first import: points the OpenAI clients (constructed at module
 * load) at the local mock AI server so the interview-completion test can run
 * the real route without network calls. */
import { MOCK_AI_PORT } from "./discovery-optin-test-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  jobsTable,
  applicationsTable,
  candidateDiscoveryConsentTable,
} from "@workspace/db";
import publicRouter from "./public";
import candidateImportRouter from "./candidate-import";
import { ensureCandidateUser } from "./invites";
import {
  grantDiscoveryOptIn,
  revokeDiscoveryOptIn,
  hasActiveDiscoveryOptIn,
  CURRENT_DISCOVERY_CONSENT_VERSION,
} from "../lib/discovery-consent";

const P = "dopt_";
const id = (s: string) => P + s;

const TENANT = id("tenant");
const JOB = id("job");
const INVITED_CAND = id("invited");

const APPLY_EMAIL = id("applicant") + "@dopt.test";
const INVITE_EMAIL = id("invited") + "@dopt.test";
const REGISTER_EMAIL = id("register") + "@dopt.test";
const STRONG_PASSWORD = "Str0ngPass!2026";

let server: Server;
let baseUrl: string;

const SES_ENV_KEYS = ["SES_FROM_EMAIL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

async function poolOf(candidateId: string): Promise<string | null> {
  const [row] = await dbAdmin
    .select({ pool: candidatesTable.pool })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);
  return (row as any)?.pool ?? null;
}

async function candidateByEmail(email: string) {
  const [row] = await dbAdmin
    .select({ id: candidatesTable.id, pool: candidatesTable.pool })
    .from(candidatesTable)
    .where(eq(candidatesTable.email, email))
    .limit(1);
  return row as { id: string; pool: string } | undefined;
}

async function cleanup() {
  await dbAdmin.delete(candidateDiscoveryConsentTable)
    .where(like(candidateDiscoveryConsentTable.candidateId, `${P}%`));
  const seeded = await dbAdmin.select({ id: candidatesTable.id }).from(candidatesTable)
    .where(like(candidatesTable.email, `%@dopt.test`));
  for (const c of seeded) {
    await dbAdmin.delete(candidateDiscoveryConsentTable)
      .where(eq(candidateDiscoveryConsentTable.candidateId, c.id));
    await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.candidateId, c.id));
  }
  await dbAdmin.delete(candidatesTable).where(like(candidatesTable.email, `%@dopt.test`));
  await dbAdmin.delete(usersTable).where(like(usersTable.email, `%@dopt.test`));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, JOB));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, TENANT));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: TENANT, name: "Discovery Opt-In Test Co", slug: TENANT, plan: "enterprise", website: "https://dopt.test" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    { id: JOB, tenantId: TENANT, title: "Test Engineer", status: "active", description: "Test role for discovery opt-in seal" } as any,
  ]);
  /* Candidate for the recruiter-invite path (already exists in the tenant,
   * as after sourcing or manual add). */
  await dbAdmin.insert(candidatesTable).values([
    {
      id: INVITED_CAND, tenantId: TENANT, firstName: "Ines", lastName: "Vited",
      email: INVITE_EMAIL, pool: "tenant",
    } as any,
  ]);
}

before(async () => {
  for (const k of SES_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  await seed();
  const app = express();
  app.use(express.json());
  app.use(publicRouter);
  app.use(candidateImportRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await cleanup();
  for (const k of SES_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
  }
  server?.close();
});

/* ── Path 1: public apply-to-job ─────────────────────────────────────────── */

test("apply-to-job does NOT place the applicant in the platform pool", async () => {
  const res = await fetch(`${baseUrl}/jobs/${JOB}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Appie", lastName: "Cant", email: APPLY_EMAIL,
    }),
  });
  assert.ok(res.status < 400, `apply should succeed, got ${res.status}: ${await res.text()}`);

  const cand = await candidateByEmail(APPLY_EMAIL);
  assert.ok(cand, "apply must create the candidate row (control: the path still works)");
  assert.notEqual(cand!.pool, "platform",
    "applying to ONE job must not make the candidate platform-discoverable");
  assert.equal(cand!.pool, "tenant", "applicant stays scoped to the tenant they applied to");
  assert.equal(await hasActiveDiscoveryOptIn(cand!.id), false);
});

test("apply-path candidate becomes discoverable ONLY via explicit opt-in, and withdrawal restores tenant scope", async () => {
  const cand = await candidateByEmail(APPLY_EMAIL);
  assert.ok(cand);

  const row = await grantDiscoveryOptIn(cand!.id, { surface: "settings", ua: "test", ip: "127.0.0.1" });
  assert.ok(row, "grant must return the consent row");
  assert.equal(await poolOf(cand!.id), "platform");
  assert.equal(await hasActiveDiscoveryOptIn(cand!.id), true);

  /* Auditable record: who, when, what language version. */
  assert.equal(row!.candidateId, cand!.id);
  assert.equal(row!.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION);
  assert.ok(row!.consentedAt, "consent timestamp recorded");
  assert.ok((row!.disclosureSnapshot as any)?.headline, "exact disclosure language snapshotted");
  assert.equal((row!.captureContext as any)?.surface, "settings");
  assert.equal(row!.previousPool, "tenant");

  const ok = await revokeDiscoveryOptIn(cand!.id);
  assert.equal(ok, true);
  assert.equal(await poolOf(cand!.id), "tenant", "withdrawal restores the pre-opt-in pool");
  assert.equal(await hasActiveDiscoveryOptIn(cand!.id), false);
  /* Audit row survives withdrawal. */
  const [kept] = await dbAdmin.select().from(candidateDiscoveryConsentTable)
    .where(eq(candidateDiscoveryConsentTable.candidateId, cand!.id)).limit(1);
  assert.ok(kept?.revokedAt, "consent row kept with revokedAt stamped (audit trail)");
});

/* ── Path 2: recruiter portal invite (ensureCandidateUser) ───────────────── */

test("recruiter invite (ensureCandidateUser) does NOT promote to the platform pool", async () => {
  const userId = await ensureCandidateUser(INVITED_CAND, TENANT);
  assert.ok(userId, "portal user must still be provisioned (control: invite path works)");
  assert.equal(await poolOf(INVITED_CAND), "tenant",
    "sending a portal invite must not make the candidate platform-discoverable");
  assert.equal(await hasActiveDiscoveryOptIn(INVITED_CAND), false);

  /* Explicit opt-in is still the only door. */
  await grantDiscoveryOptIn(INVITED_CAND, { surface: "onboarding" });
  assert.equal(await poolOf(INVITED_CAND), "platform");
  await revokeDiscoveryOptIn(INVITED_CAND);
  assert.equal(await poolOf(INVITED_CAND), "tenant");
});

/* ── Path 3: public self-register ────────────────────────────────────────── */

test("self-register lands in pending_profile (hidden), platform only via explicit opt-in", async () => {
  const res = await fetch(`${baseUrl}/career-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Selfie", lastName: "Reg", email: REGISTER_EMAIL, password: STRONG_PASSWORD,
    }),
  });
  assert.ok(res.status < 400, `register should succeed, got ${res.status}`);

  const cand = await candidateByEmail(REGISTER_EMAIL);
  assert.ok(cand, "register must create the candidate row (control)");
  assert.equal(cand!.pool, "pending_profile", "self-registered candidate starts hidden");

  const row = await grantDiscoveryOptIn(cand!.id, { surface: "onboarding" });
  assert.ok(row);
  assert.equal(row!.previousPool, "pending_profile");
  assert.equal(await poolOf(cand!.id), "platform");

  await revokeDiscoveryOptIn(cand!.id);
  assert.equal(await poolOf(cand!.id), "pending_profile",
    "withdrawal restores the hidden pending_profile stage, not tenant");
});

/* ── Idempotency ─────────────────────────────────────────────────────────── */

test("granting twice is idempotent (no duplicate active consent rows)", async () => {
  const cand = await candidateByEmail(REGISTER_EMAIL);
  assert.ok(cand);
  const a = await grantDiscoveryOptIn(cand!.id, { surface: "settings" });
  const b = await grantDiscoveryOptIn(cand!.id, { surface: "settings" });
  assert.ok(a && b);
  assert.equal(a!.id, b!.id, "second grant returns the existing active row");
  const rows = await dbAdmin.select().from(candidateDiscoveryConsentTable)
    .where(and(
      eq(candidateDiscoveryConsentTable.candidateId, cand!.id),
      eq(candidateDiscoveryConsentTable.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION),
    ));
  const active = rows.filter(r => !r.revokedAt);
  assert.equal(active.length, 1, "exactly one active consent row");
});

/* ── Concurrency: the partial unique index is the race backstop ──────────── */

test("concurrent double-grant collapses to ONE active consent row", async () => {
  const cand = await candidateByEmail(REGISTER_EMAIL);
  assert.ok(cand);
  /* Start from a clean revoked state so both grants race on insert. */
  await revokeDiscoveryOptIn(cand!.id);
  const [a, b] = await Promise.all([
    grantDiscoveryOptIn(cand!.id, { surface: "settings" }),
    grantDiscoveryOptIn(cand!.id, { surface: "onboarding" }),
  ]);
  assert.ok(a && b, "both concurrent grants must resolve (winner + 23505 path)");
  assert.equal(await poolOf(cand!.id), "platform");
  const rows = await dbAdmin.select().from(candidateDiscoveryConsentTable)
    .where(and(
      eq(candidateDiscoveryConsentTable.candidateId, cand!.id),
      eq(candidateDiscoveryConsentTable.consentVersion, CURRENT_DISCOVERY_CONSENT_VERSION),
    ));
  const active = rows.filter(r => !r.revokedAt);
  assert.equal(active.length, 1, "unique index guarantees a single active row under race");
  await revokeDiscoveryOptIn(cand!.id);
});

/* ── Path 4: baseline interview completion (the removed auto-promotion) ──── */

test("completing the baseline career interview does NOT promote to the platform pool", async () => {
  /* Mock AI backend: every chat-completion returns a fixed payload. The
   * extraction call JSON.parses it; transcript/analysis calls treat it as
   * text. One shape satisfies both. */
  const mockAi = express();
  mockAi.use(express.json({ limit: "5mb" }));
  mockAi.post(/.*chat\/completions.*/, (_req, res) => {
    res.json({
      choices: [{ message: { content: JSON.stringify({
        currentTitle: "Test Engineer", currentCompany: "Acme", yearsExperience: 5,
        bio: "Test bio.", skills: ["testing"], education: null,
        careerGoal3yr: "grow", careerGoal5yr: "lead", targetCompanies: [],
        targetIndustries: [], preferredRoles: [], preferredWorkStyle: null,
        motivations: [], workAuthorized: null, requiresSponsorship: null,
        sponsorshipCountry: null, sponsorshipNotes: null,
        strengthAreas: ["focus"], growthAreas: ["scope"], aiSummary: "Summary.",
        careerPaths: [],
      }) } }],
    });
  });
  const mockServer = await new Promise<Server>((resolve) => {
    const s = mockAi.listen(MOCK_AI_PORT, "127.0.0.1", () => resolve(s));
  });

  try {
    const cand = await candidateByEmail(REGISTER_EMAIL);
    assert.ok(cand, "self-registered candidate exists from Path 3");
    /* Self-heal from earlier tests: ensure no active opt-in remains. */
    await revokeDiscoveryOptIn(cand!.id);
    assert.notEqual(await poolOf(cand!.id), "platform", "precondition: not in platform pool");

    /* Resolve the candidate's portal user and mint a real portal token. */
    const [u] = await dbAdmin.select({ id: usersTable.id, tenantId: usersTable.tenantId })
      .from(usersTable).where(eq(usersTable.email, REGISTER_EMAIL)).limit(1);
    assert.ok(u, "portal user row exists");
    const { issueToken } = await import("../lib/auth-token");
    const token = issueToken({ userId: u!.id, role: "candidate", tenantId: u!.tenantId });

    /* Mount the REAL career-profile router (dynamic import so the mock AI
     * env from discovery-optin-test-env.ts is in force at module load). */
    const careerProfileRouter = (await import("./career-profile")).default;
    const app2 = express();
    app2.use(express.json({ limit: "5mb" }));
    app2.use(careerProfileRouter);
    const server2 = await new Promise<Server>((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    const base2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;

    try {
      const history = [
        { role: "assistant", content: "Tell me about your background." },
        { role: "user", content: "I am a test engineer at Acme with five years of experience." },
        { role: "assistant", content: "What are your career goals?" },
        { role: "user", content: "I want to grow into a lead role over the next few years." },
      ];
      const res = await fetch(`${base2}/portal/career-interview/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ history, language: "en-US" }),
      });
      assert.ok(res.status < 400,
        `interview completion should succeed (control), got ${res.status}: ${await res.text()}`);

      assert.notEqual(await poolOf(cand!.id), "platform",
        "completing the baseline interview must NOT auto-promote into the platform pool");
      assert.equal(await hasActiveDiscoveryOptIn(cand!.id), false,
        "no consent row minted as a side effect of interview completion");
    } finally {
      server2.close();
    }
  } finally {
    mockServer.close();
  }
});

/* ── Path 5: staff bulk-import (July 2026 ruling) ────────────────────────────
 * Imported candidates are tenant-scoped. The import endpoint must REQUIRE a
 * tenantId and never default to pool='platform'. */
test("bulk-import without tenantId is rejected (no silent platform default)", async () => {
  const savedKey = process.env.LEXY_IMPORT_API_KEY;
  process.env.LEXY_IMPORT_API_KEY = "dopt-import-test-key";
  try {
    const form = new FormData();
    form.append("resume", new Blob(["dummy resume text"], { type: "text/plain" }), "resume.txt");
    const res = await fetch(`${baseUrl}/candidates/import`, {
      method: "POST",
      headers: { Authorization: "Bearer dopt-import-test-key" },
      body: form,
    });
    assert.equal(res.status, 400, "missing tenantId must be a 400, not a platform-pool import");
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /tenantId is required/i);
  } finally {
    if (savedKey === undefined) delete process.env.LEXY_IMPORT_API_KEY;
    else process.env.LEXY_IMPORT_API_KEY = savedKey;
  }
});

test("bulk-import with an unknown tenantId is rejected (never falls back to platform)", async () => {
  const savedKey = process.env.LEXY_IMPORT_API_KEY;
  process.env.LEXY_IMPORT_API_KEY = "dopt-import-test-key";
  try {
    const form = new FormData();
    form.append("resume", new Blob(["dummy resume text"], { type: "text/plain" }), "resume.txt");
    form.append("tenantId", "00000000-0000-0000-0000-00000000dead");
    const res = await fetch(`${baseUrl}/candidates/import`, {
      method: "POST",
      headers: { Authorization: "Bearer dopt-import-test-key" },
      body: form,
    });
    assert.equal(res.status, 400, "unknown tenantId must be a 400, not a platform-pool fallback");
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /Tenant not found/i);
  } finally {
    if (savedKey === undefined) delete process.env.LEXY_IMPORT_API_KEY;
    else process.env.LEXY_IMPORT_API_KEY = savedKey;
  }
});
