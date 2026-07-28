/**
 * ownership.test.ts — unit tests for the recruiter ownership-enforcement
 * middleware (enforceOwnership) in lib/ownership.ts.
 *
 * Proves the approved matrix behaviour in isolation (no real routes converted):
 *   (1) plain recruiter + OWNED resource            → passes (200)
 *   (2) plain recruiter + UNOWNED resource, same tenant → 404 (existence hidden)
 *   (3) recruiter_admin + UNOWNED resource          → passes (200, bypasses ceiling)
 *   (4) missing id / malformed id                   → 400
 *   (5) BODY-supplied id enforced exactly like a PARAM id
 *   + candidate / application / campaign resolution, `:id` alias, exemptFromOwnership.
 *
 * Harness: the middleware is mounted on a bare Express app with a shim that
 * injects req.resolvedUser (mirroring resolveUser). Data is seeded via dbAdmin
 * with the `own_` id prefix. Two jobs in ONE tenant — one assigned to the
 * recruiter, one not — so case (2) is a genuine same-tenant unowned check.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  jobsTable,
  applicationsTable,
  outreachCampaignsTable,
} from "@workspace/db";
import {
  enforceOwnership,
  exemptFromOwnership,
  OWNERSHIP_EXEMPTION,
  listOwnershipExemptions,
} from "./ownership";
import { issueToken } from "./auth-token";

const P = "own_";
const id = (s: string) => P + s;

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["recruiter", "recAdmin", "recNoReq"].map(id);
const JOB_IDS = ["jobOwned", "jobUnowned", "jobOtherTenant"].map(id);
const CAND_IDS = ["candOwned", "candUnowned"].map(id);
const APP_IDS = ["appOwned", "appUnowned"].map(id);
const CAMP_IDS = ["campOwned", "campUnowned"].map(id);

// The users we inject as req.resolvedUser via the ?as= query in the test app.
const USERS: Record<string, { id: string; role: string; tenantId: string }> = {
  recruiter: { id: id("recruiter"), role: "recruiter", tenantId: id("tenantA") },
  recAdmin: { id: id("recAdmin"), role: "recruiter_admin", tenantId: id("tenantA") },
  recNoReq: { id: id("recNoReq"), role: "recruiter", tenantId: id("tenantA") },
};

let server: Server;
let baseUrl: string;

async function api(
  path: string,
  as: string,
  init?: { method?: string; body?: any },
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path + (path.includes("?") ? "&" : "?") + "as=" + as, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function cleanupDb() {
  await dbAdmin.delete(outreachCampaignsTable).where(inArray(outreachCampaignsTable.id, CAMP_IDS));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.id, APP_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, CAND_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, JOB_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

before(async () => {
  await cleanupDb();
  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "Own Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "Own Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("recruiter"), tenantId: id("tenantA"), email: id("recruiter") + "@t.test", name: "Rec", passwordHash: "x", role: "recruiter" },
    { id: id("recAdmin"), tenantId: id("tenantA"), email: id("recAdmin") + "@t.test", name: "Rec Admin", passwordHash: "x", role: "recruiter_admin" },
    { id: id("recNoReq"), tenantId: id("tenantA"), email: id("recNoReq") + "@t.test", name: "Rec NoReq", passwordHash: "x", role: "recruiter" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    // Assigned to our recruiter → owned.
    { id: id("jobOwned"), tenantId: id("tenantA"), title: "Owned", description: "d", status: "active", assignedRecruiterId: id("recruiter") },
    // Same tenant, NOT assigned to our recruiter → unowned (case 2).
    { id: id("jobUnowned"), tenantId: id("tenantA"), title: "Unowned", description: "d", status: "active" },
    { id: id("jobOtherTenant"), tenantId: id("tenantB"), title: "Other", description: "d", status: "active" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candOwned"), tenantId: id("tenantA"), firstName: "Cand", lastName: "Owned", email: id("candOwned") + "@t.test", pool: "tenant" },
    { id: id("candUnowned"), tenantId: id("tenantA"), firstName: "Cand", lastName: "Unowned", email: id("candUnowned") + "@t.test", pool: "tenant" },
  ]);
  await dbAdmin.insert(applicationsTable).values([
    { id: id("appOwned"), tenantId: id("tenantA"), candidateId: id("candOwned"), jobId: id("jobOwned"), stage: "applied" },
    { id: id("appUnowned"), tenantId: id("tenantA"), candidateId: id("candUnowned"), jobId: id("jobUnowned"), stage: "applied" },
  ]);
  await dbAdmin.insert(outreachCampaignsTable).values([
    { id: id("campOwned"), tenantId: id("tenantA"), jobId: id("jobOwned"), name: "Camp Owned" },
    { id: id("campUnowned"), tenantId: id("tenantA"), jobId: id("jobUnowned"), name: "Camp Unowned" },
  ]);

  const app = express();
  app.use(express.json());
  // Shim: inject req.resolvedUser from ?as= so the middleware sees a caller
  // exactly as resolveUser would set it.
  app.use((req: any, _res, next) => {
    const who = String((req.query as any).as ?? "");
    req.resolvedUser = USERS[who]; // undefined when who is absent → drives 401 path
    next();
  });

  const ok: express.RequestHandler = (_req, res) => res.status(200).json({ ok: true });

  app.get("/job/:jobId", enforceOwnership(), ok);
  app.get("/candidate/:candidateId", enforceOwnership(), ok);
  app.get("/app/:applicationId", enforceOwnership(), ok);
  // `:id` alias → treated as a campaignId (mirrors outreach /campaigns/:id).
  app.get("/campaign/:id", enforceOwnership({ kinds: ["campaignId"], paramAliases: { campaignId: ["id"] } }), ok);
  // No id at all in the route → requireId default true ⇒ 400.
  app.get("/noid", enforceOwnership(), ok);
  // Body-supplied jobId (POST) — enforced exactly like a param.
  app.post("/body-job", enforceOwnership({ kinds: ["jobId"] }), ok);
  // Optional-id route: absence passes, presence still enforced.
  app.post("/optional-job", enforceOwnership({ kinds: ["jobId"], requireId: false }), ok);
  // Exempt route: opts OUT of ownership entirely (used INSTEAD of enforceOwnership),
  // so a plain recruiter with an unowned id still passes.
  app.get("/exempt/:jobId", exemptFromOwnership("GET /exempt/:jobId", OWNERSHIP_EXEMPTION.NO_OWNABLE_RESOURCE), ok);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await cleanupDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── (1) plain recruiter + OWNED ─────────────────────────────────────────── */
test("recruiter + owned job → 200", async () => {
  const r = await api(`/job/${id("jobOwned")}`, "recruiter");
  assert.equal(r.status, 200);
});

/* ── (2) plain recruiter + UNOWNED, same tenant → 404 ────────────────────── */
test("recruiter + unowned job (same tenant) → 404", async () => {
  const r = await api(`/job/${id("jobUnowned")}`, "recruiter");
  assert.equal(r.status, 404);
});

test("recruiter + job in another tenant → 404", async () => {
  const r = await api(`/job/${id("jobOtherTenant")}`, "recruiter");
  assert.equal(r.status, 404);
});

test("recruiter with NO assigned reqs owns nothing → 404", async () => {
  const r = await api(`/job/${id("jobOwned")}`, "recNoReq");
  assert.equal(r.status, 404);
});

/* ── (3) recruiter_admin bypasses the recruiter ceiling → 200 ────────────── */
test("recruiter_admin + unowned job → 200 (bypasses recruiter ceiling)", async () => {
  const r = await api(`/job/${id("jobUnowned")}`, "recAdmin");
  assert.equal(r.status, 200);
});

/* ── (4) missing / malformed ids → 400 ───────────────────────────────────── */
test("no id on an ownership route → 400", async () => {
  const r = await api(`/noid`, "recruiter");
  assert.equal(r.status, 400);
});

test("malformed (blank) param id → 400", async () => {
  const r = await api(`/job/%20`, "recruiter"); // "%20" → " " → trims to empty
  assert.equal(r.status, 400);
});

test("malformed (blank) body id → 400", async () => {
  const r = await api(`/body-job`, "recruiter", { method: "POST", body: { jobId: "   " } });
  assert.equal(r.status, 400);
});

/* ── (5) body-supplied id enforced like a param ──────────────────────────── */
test("recruiter + owned jobId in BODY → 200", async () => {
  const r = await api(`/body-job`, "recruiter", { method: "POST", body: { jobId: id("jobOwned") } });
  assert.equal(r.status, 200);
});

test("recruiter + unowned jobId in BODY → 404", async () => {
  const r = await api(`/body-job`, "recruiter", { method: "POST", body: { jobId: id("jobUnowned") } });
  assert.equal(r.status, 404);
});

/* ── candidate resolution ────────────────────────────────────────────────── */
test("recruiter + candidate reachable via owned req → 200", async () => {
  const r = await api(`/candidate/${id("candOwned")}`, "recruiter");
  assert.equal(r.status, 200);
});

test("recruiter + candidate only on an unowned req → 404", async () => {
  const r = await api(`/candidate/${id("candUnowned")}`, "recruiter");
  assert.equal(r.status, 404);
});

/* ── application resolution (resolve app → jobId) ────────────────────────── */
test("recruiter + application on owned req → 200", async () => {
  const r = await api(`/app/${id("appOwned")}`, "recruiter");
  assert.equal(r.status, 200);
});

test("recruiter + application on unowned req → 404", async () => {
  const r = await api(`/app/${id("appUnowned")}`, "recruiter");
  assert.equal(r.status, 404);
});

test("recruiter + non-existent application id → 404 (existence hidden)", async () => {
  const r = await api(`/app/${id("nope")}`, "recruiter");
  assert.equal(r.status, 404);
});

/* ── campaign resolution via `:id` alias ─────────────────────────────────── */
test("recruiter + campaign (`:id` alias) on owned req → 200", async () => {
  const r = await api(`/campaign/${id("campOwned")}`, "recruiter");
  assert.equal(r.status, 200);
});

test("recruiter + campaign (`:id` alias) on unowned req → 404", async () => {
  const r = await api(`/campaign/${id("campUnowned")}`, "recruiter");
  assert.equal(r.status, 404);
});

/* ── optional-id route ───────────────────────────────────────────────────── */
test("optional-id route: absent id → 200 (pass-through)", async () => {
  const r = await api(`/optional-job`, "recruiter", { method: "POST", body: {} });
  assert.equal(r.status, 200);
});

test("optional-id route: present UNOWNED id → 404 (still enforced)", async () => {
  const r = await api(`/optional-job`, "recruiter", { method: "POST", body: { jobId: id("jobUnowned") } });
  assert.equal(r.status, 404);
});

/* ── auth precondition ───────────────────────────────────────────────────── */
test("no resolvedUser → 401", async () => {
  const r = await api(`/job/${id("jobOwned")}`, "");
  assert.equal(r.status, 401);
});

/* ── caller fallback: getAuthUserId path (no resolvedUser shim) ──────────── */
test("resolves caller from bearer token when resolvedUser absent → owned 200", async () => {
  const token = issueToken({ userId: id("recruiter"), role: "recruiter", tenantId: id("tenantA") });
  const res = await fetch(baseUrl + `/job/${id("jobOwned")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
});

test("resolves caller from bearer token → unowned 404", async () => {
  const token = issueToken({ userId: id("recruiter"), role: "recruiter", tenantId: id("tenantA") });
  const res = await fetch(baseUrl + `/job/${id("jobUnowned")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
});

/* ── exemption ───────────────────────────────────────────────────────────── */
test("exemptFromOwnership: recruiter + unowned id passes on exempt route", async () => {
  const r = await api(`/exempt/${id("jobUnowned")}`, "recruiter");
  assert.equal(r.status, 200);
});

test("exemptFromOwnership registers a named justification", () => {
  const found = listOwnershipExemptions().find((e) => e.route === "GET /exempt/:jobId");
  assert.ok(found);
  assert.equal(found!.justification, OWNERSHIP_EXEMPTION.NO_OWNABLE_RESOURCE);
});

test("exemptFromOwnership rejects an anonymous (unknown) justification", () => {
  assert.throws(() => exemptFromOwnership("GET /whatever", "just because" as any));
});
